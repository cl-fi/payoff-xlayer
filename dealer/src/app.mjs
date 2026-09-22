import Fastify from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isAddress } from 'viem';
import { z } from 'zod';
import { signQuote } from '../../sdk/quotes.mjs';
import { uint } from './config.mjs';
import { NoQuote, marketDataMode, optionFor, priceQuote, same } from './pricing.mjs';

const addr = z.string().refine(v => isAddress(v, { strict: false }));
const positive = uint.refine(v => BigInt(v) > 0n);
const requestSchema = z.strictObject({
  version: z.literal('1'), requestId: z.string().regex(/^0x[\da-fA-F]{64}$/),
  chainId: z.number().int().positive(), exchange: addr,
  order: z.strictObject({ taker: addr, vault: addr, seriesId: positive, wrappedQuantity: positive }),
  // The dealer obtains authoritative terms from the chain, never trusts the supplied snapshot.
  snapshot: z.object({}).passthrough(), collectUntil: z.iso.datetime(),
});
export async function buildDealerApp({ config, chain, provider, account, token, logger = false }) {
  const app = Fastify({ logger: logger ? { level: 'info', redact: ['req.headers.authorization'] } : false, bodyLimit: 16384 });
  const credential = Buffer.from(`Bearer ${token}`);
  let active = 0;
  app.addHook('onSend', async (_req, reply, body) => { reply.header('cache-control', 'no-store'); return body; });
  app.setErrorHandler((_error, _req, reply) => reply.code(400).send({ error: 'INVALID_REQUEST' }));
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      if (!provider.ready) throw new Error('Market data unavailable');
      await chain.health();
      return { status: 'ready', dealer: account.address };
    } catch { return reply.code(503).send({ status: 'unavailable' }); }
  });
  app.post('/quote', async (req, reply) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (credential.length !== supplied.length || !timingSafeEqual(credential, supplied)) return reply.code(401).send({ error: 'UNAUTHORIZED' });
    const request = requestSchema.parse(req.body);
    if (active >= 4) return { status: 'no_quote', reason: 'DEALER_BUSY' };
    active++;
    try {
      if (request.chainId !== config.chainId || !same(request.exchange, config.exchange)) throw new NoQuote('WRONG_DOMAIN');
      const collectUntil = Date.parse(request.collectUntil);
      if (collectUntil <= Date.now() || collectUntil > Date.now() + 60000) throw new NoQuote('COLLECTION_EXPIRED');
      const context = await chain.context(request.order);
      const option = optionFor(context);
      const market = await provider.quote(option);
      const premium = priceQuote(context, market, config);
      await chain.funded(premium.grossPremiumUSDG, context.blockNumber);
      if (Date.now() >= collectUntil || Number(premium.deadline) * 1000 <= Date.now() + 3000) throw new NoQuote('COLLECTION_EXPIRED');
      const quote = { ...request.order, requestId: request.requestId, dealer: account.address,
        strikeAmountUSDG: context.strikeAmountUSDG, ...premium, issuedAt: context.timestamp,
        nonce: BigInt(`0x${randomBytes(32).toString('hex')}`).toString() };
      const signature = await signQuote(account, config.chainId, config.exchange, quote);
      req.log.info({ requestId: request.requestId, ...option, bidMicros: market.bidMicros,
        marketDataMode: marketDataMode(market, config), referenceSource: market.referenceSource,
        fallbackReason: market.fallbackReason, marketAgeMs: Math.max(0, Date.now() - market.timestampMs),
        marketTimestampMs: market.timestampMs, wrappedQuantity: request.order.wrappedQuantity,
        stockQuantity: context.stockQuantity.toString(), premiumBasis: config.premiumBasis, ...premium }, 'quote priced');
      return { status: 'quote', quote, signature };
    } catch (error) {
      const reason = error instanceof NoQuote ? error.code : 'DEALER_UNAVAILABLE';
      req.log.info({ requestId: request.requestId, reason }, 'quote declined');
      return { status: 'no_quote', reason };
    } finally { active--; }
  });
  return app;
}
