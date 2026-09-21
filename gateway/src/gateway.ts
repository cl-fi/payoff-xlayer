import { performance } from 'node:perf_hooks';
import { quoteDigest } from '../../sdk/quotes.mjs';
import type { Config, Dealer } from './config.js';
import { transactionFor, type Chain } from './chain.js';
import { requestDealer } from './dealer.js';
import { asGatewayError, GatewayError, within } from './errors.js';
import { Store, digest, type RecordRow } from './store.js';
import type { DealerRequest, Order, Outcome, Quote, RfqResult, Selection, SignedQuote } from './types.js';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function checkEnvelope(request: DealerRequest, dealer: Dealer, signed: SignedQuote) {
  const q = signed.quote;
  const { order, snapshot } = request;
  if (q.requestId !== request.requestId || !same(q.dealer, dealer.address) || !same(q.taker, order.taker)
    || !same(q.vault, order.vault) || q.seriesId !== order.seriesId || q.wrappedQuantity !== order.wrappedQuantity
    || q.strikeAmountUSDG !== snapshot.strikeAmountUSDG) {
    throw new GatewayError('QUOTE_TERMS', 'Dealer changed the requested terms or identity.');
  }
  const gross = BigInt(q.grossPremiumUSDG);
  const fee = gross * BigInt(snapshot.feeBps) / 10000n;
  if (BigInt(q.protocolFeeUSDG) !== fee || BigInt(q.netPremiumUSDG) + fee !== gross) {
    throw new GatewayError('QUOTE_FEES', 'Quote fees do not match the Exchange.');
  }
}
export function compareQuotes(a: Selection, b: Selection) {
  const left = BigInt(a.quote.netPremiumUSDG), right = BigInt(b.quote.netPremiumUSDG);
  if (left !== right) return left > right ? -1 : 1;
  // Public deterministic tie-break, independent of response order or self-operated status.
  return a.quote.dealer.toLowerCase().localeCompare(b.quote.dealer.toLowerCase());
}
function stillValid(q: Quote, context: DealerRequest | null) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return BigInt(q.deadline) > now && (!context || BigInt(context.snapshot.terms.tradeCutoff) > now);
}
export function publicRecord(row: RecordRow) {
  if (!row.result) return { requestId: row.request_id, status: 'collecting' as const };
  if (row.result.selection && !stillValid(row.result.selection.quote, row.context)) {
    return { ...row.result, status: 'expired', selection: { ...row.result.selection, transaction: null } };
  }
  return row.result;
}
export class Gateway {
  private active = 0;
  constructor(readonly config: Config, readonly chain: Chain, readonly store: Store, private tokens: Map<string, string> = new Map()) {}
  async create(order: Order, key: string) {
    const keyHash = digest(`${this.config.chainId}:${this.config.exchange.toLowerCase()}:${key}`);
    const claim = await this.store.claim(keyHash, order, this.config.requestTimeoutMs + 10000);
    if (!claim.owned) return { httpStatus: claim.row.http_status ?? 202, body: publicRecord(claim.row) };
    const audit: Outcome[] = [];
    const requestId = claim.row.request_id;
    let result: RfqResult;
    let httpStatus = 200;
    const controller = new AbortController();
    if (this.active >= this.config.maxConcurrentRfqs) {
      result = { requestId, status: 'failed', responses: [], error: { code: 'GATEWAY_BUSY', message: 'Gateway is busy. Retry later with a new idempotency key.' } };
      httpStatus = 503;
    } else {
      this.active++;
      try { result = await within(this.collect(requestId, order, audit, controller.signal), this.config.requestTimeoutMs); }
      catch (e) {
        const error = asGatewayError(e);
        result = { requestId, status: 'failed', responses: [], error: { code: error.code, message: error.message } };
        httpStatus = error.statusCode;
      } finally { controller.abort(); this.active--; }
    }
    await this.store.complete(requestId, result, audit, httpStatus);
    return { httpStatus, body: result };
  }
  private async collect(requestId: `0x${string}`, order: Order, audit: Outcome[], signal: AbortSignal): Promise<RfqResult> {
    const snapshot = await this.chain.snapshot(order);
    await this.chain.takerReady(order, snapshot);
    signal.throwIfAborted();
    const request: DealerRequest = { version: '1', requestId, chainId: this.config.chainId, exchange: this.config.exchange,
      order, snapshot, collectUntil: new Date(Date.now() + this.config.collectMs).toISOString() };
    await this.store.context(requestId, request);
    signal.throwIfAborted();
    if (Date.now() >= Date.parse(request.collectUntil)) throw new GatewayError('COLLECTION_WINDOW_EXPIRED', 'Could not start collection before its deadline.', 503);
    // The same deadline applies to every dealer. An immediate response from the only dealer is returned without padding the window.
    const collectionSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Date.parse(request.collectUntil) - Date.now()))]);
    const responses = await Promise.all(this.config.dealers.filter(d => d.enabled).map(async dealer => {
      const start = performance.now();
      const outcome: Outcome = { dealerId: dealer.id, status: 'error', elapsedMs: 0 };
      audit.push(outcome);
      try {
        const response = await requestDealer(dealer, request, this.tokens.get(dealer.id), collectionSignal);
        if (Date.now() >= Date.parse(request.collectUntil)) throw new GatewayError('DEALER_TIMEOUT', 'Collection window ended.');
        if (response.status === 'no_quote') { outcome.status = 'no_quote'; outcome.code = 'DEALER_DECLINED'; return null; }
        const signed: SignedQuote = { quote: response.quote, signature: response.signature };
        outcome.signedQuote = signed;
        checkEnvelope(request, dealer, signed);
        return { dealer, signed, outcome };
      } catch (e) {
        outcome.status = collectionSignal.aborted ? 'timeout' : 'rejected';
        outcome.code = collectionSignal.aborted ? 'DEALER_TIMEOUT' : e instanceof GatewayError ? e.code : 'DEALER_RESPONSE';
        return null;
      } finally { outcome.elapsedMs = Math.round(performance.now() - start); }
    }));
    signal.throwIfAborted();
    const validated = await Promise.all(responses.map(async response => {
      if (!response) return null;
      const { dealer, signed, outcome } = response;
      try {
        const checked = await this.chain.validate(request, signed);
        signal.throwIfAborted();
        if (!stillValid(signed.quote, request)) throw new GatewayError('QUOTE_TIME', 'Quote expired during validation.');
        outcome.status = 'valid';
        return { ...signed, dealerId: dealer.id, dealerName: dealer.name, source: dealer.source,
          quoteHash: quoteDigest(this.config.chainId, this.config.exchange, signed.quote),
          transaction: transactionFor(this.config, signed, snapshot.terms.side), checkedAtBlock: checked.blockNumber,
          checkedAt: new Date().toISOString() } satisfies Selection;
      } catch (e) {
        outcome.status = 'rejected'; outcome.code = asGatewayError(e).code; return null;
      }
    }));
    signal.throwIfAborted();
    const candidates = validated.filter((s): s is Selection => {
      if (!s) return false;
      if (stillValid(s.quote, request)) return true;
      const outcome = audit.find(a => a.dealerId === s.dealerId)!;
      outcome.status = 'rejected'; outcome.code = 'QUOTE_TIME'; return false;
    }).sort(compareQuotes);
    const selection = candidates[0];
    return { requestId, status: selection ? 'quoted' : 'no_quote', ...(selection ? { selection } : {}),
      responses: audit.map(({ dealerId, status, code }) => ({ dealerId, status, ...(code ? { code } : {}) })) };
  }
  async prepare(requestId: string) {
    const row = await this.store.get(requestId);
    const selection = row.result?.selection;
    if (!selection || !row.context) throw new GatewayError('NO_SELECTED_QUOTE', 'There is no selected quote for this request.', 409);
    if (!stillValid(selection.quote, row.context)) throw new GatewayError('QUOTE_EXPIRED', 'Request a new quote and confirm its terms again.', 409);
    const checked = await within(this.chain.validate(row.context, selection), this.config.requestTimeoutMs);
    if (!stillValid(selection.quote, row.context)) throw new GatewayError('QUOTE_EXPIRED', 'Quote expired during validation.', 409);
    return { requestId, status: 'ready', selection: { ...selection, checkedAtBlock: checked.blockNumber, checkedAt: new Date().toISOString() } };
  }
  async transaction(requestId: string, transactionHash: `0x${string}`) {
    const row = await this.store.get(requestId);
    const selection = row.result?.selection;
    if (!selection) throw new GatewayError('NO_SELECTED_QUOTE', 'There is no selected quote for this request.', 409);
    const observation = await within(this.chain.settlement(selection, transactionHash), this.config.requestTimeoutMs);
    await this.store.transaction(requestId, observation);
    return { requestId, ...observation };
  }
}
