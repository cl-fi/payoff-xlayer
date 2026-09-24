import { UserFacingError } from '../errors';
import type { Address } from 'viem';
import { z } from 'zod';
import { WAD, ceilDiv } from '../amounts';
import type {
  AppQuote,
  Balances,
  DemoQuote,
  DemoState,
  Market,
  Position,
  Preview,
  ProductAdapter,
  Scenario,
} from '../types';

// These addresses identify a browser-only sandbox. They are never sent to a wallet or RPC.
export const DEMO_ACCOUNT = '0x000000000000000000000000000000000000de01' as Address;
const EXCHANGE = '0x000000000000000000000000000000000000de02' as Address;
const VAULT = '0x000000000000000000000000000000000000de03' as Address;
const DEALER = '0x000000000000000000000000000000000000de04' as Address;
const RATE = '1003000000000000000';
const FEE_BPS = 1000;
const DAY = 86400;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const STORAGE_PREFIX = 'payoff.demo.v1.';
export function initialDemoState(now = Math.floor(Date.now() / 1000)): DemoState {
  return {
    version: 1,
    anchor: now,
    balances: {
      usdg: '10000000000',
      stock: '8000000000000000000',
      wrapped: '0',
      usdgAllowance: '0',
      wrappedAllowance: '0',
    },
    positions: [],
    filledRequests: [],
  };
}
export function demoMarket(anchor: number): Market {
  return {
    chainId: 1952,
    exchange: EXCHANGE,
    usdg: '0x000000000000000000000000000000000000de05',
    stock: '0x000000000000000000000000000000000000de06',
    wrappedStock: '0x000000000000000000000000000000000000de07',
    rate: RATE,
    blockNumber: '0',
    feeBps: FEE_BPS,
    series: [7, 14].flatMap((days, index) =>
      ([0, 1] as const).map((side) => ({
        id: String(index * 2 + side + 1),
        side,
        days,
        vault: VAULT,
        label: `${days}-day series`,
        strikePricePerWrappedUSDG: side === 0 ? '175525000' : '185555000',
        tradeCutoff: String(anchor + days * DAY - 3600),
        exerciseStart: String(anchor + days * DAY),
        exerciseEnd: String(anchor + days * DAY + 1800),
      })),
    ),
  };
}

const uint = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .max(78);
const address = z.string().regex(/^0x[\da-fA-F]{40}$/);
const balancesSchema = z.object({
  usdg: uint,
  stock: uint,
  wrapped: uint,
  usdgAllowance: uint,
  wrappedAllowance: uint,
});
const seriesSchema = z.object({
  id: uint,
  side: z.union([z.literal(0), z.literal(1)]),
  days: z.number().positive(),
  vault: address,
  label: z.string(),
  strikePricePerWrappedUSDG: uint,
  tradeCutoff: uint,
  exerciseStart: uint,
  exerciseEnd: uint,
});
const stateSchema = z.object({
  version: z.literal(1),
  anchor: z.number().int().positive(),
  balances: balancesSchema,
  filledRequests: z.array(z.string()),
  positions: z.array(
    z.object({
      id: z.string(),
      source: z.literal('demo'),
      account: address,
      vault: address,
      series: seriesSchema,
      wrappedQuantity: uint,
      strikeAmountUSDG: uint,
      netPremiumUSDG: uint,
      entryRate: uint,
      openedAt: z.number(),
      status: z.enum(['open', 'exercised', 'expired', 'claimed']),
      outcome: z.enum(['exercised', 'expired']).optional(),
    }),
  ),
});
export interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export function readDemoState(storage: Storage, account: Address): DemoState {
  const raw = storage.getItem(STORAGE_PREFIX + account.toLowerCase());
  if (!raw) return initialDemoState();
  try {
    return stateSchema.parse(JSON.parse(raw)) as DemoState;
  } catch {
    throw new UserFacingError(
      'Local demo records could not be read. Reset them in Demo settings. Real wallet assets are unaffected.',
    );
  }
}
export function prepareDemo(state: DemoState, preview: Preview): DemoState {
  const next = structuredClone(state),
    b = next.balances;
  if (preview.series.side === 0) {
    if (BigInt(b.usdg) < BigInt(preview.strikeAmountUSDG))
      throw new UserFacingError(
        'Insufficient demo USDG balance. Reduce the quantity or reset your demo account.',
      );
    b.usdgAllowance = preview.strikeAmountUSDG;
  } else {
    const shortage = BigInt(preview.wrappedQuantity) - BigInt(b.wrapped);
    if (shortage > 0n) {
      const neededStock = ceilDiv(shortage * BigInt(preview.rate), WAD);
      if (BigInt(b.stock) < neededStock)
        throw new UserFacingError(
          'Insufficient demo stock balance. Reduce the quantity or reset your demo account.',
        );
      b.stock = (BigInt(b.stock) - neededStock).toString();
      b.wrapped = (BigInt(b.wrapped) + shortage).toString();
    }
    b.wrappedAllowance = preview.wrappedQuantity;
  }
  return next;
}
export function isPrepared(b: Balances, preview: Preview) {
  return preview.series.side === 0
    ? BigInt(b.usdg) >= BigInt(preview.strikeAmountUSDG) &&
        BigInt(b.usdgAllowance) >= BigInt(preview.strikeAmountUSDG)
    : BigInt(b.wrapped) >= BigInt(preview.wrappedQuantity) &&
        BigInt(b.wrappedAllowance) >= BigInt(preview.wrappedQuantity);
}
export function createDemoQuote(
  preview: Preview,
  now = Math.floor(Date.now() / 1000),
  expired = false,
): DemoQuote {
  const gross = (BigInt(preview.wrappedQuantity) * (preview.series.days === 7 ? 1800000n : 2700000n)) / WAD;
  const fee = (gross * BigInt(FEE_BPS)) / 10000n;
  const deadline = Math.min(now + 90, Number(preview.series.tradeCutoff));
  const requestId =
    `0x${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}` as `0x${string}`;
  return {
    kind: 'demo',
    feeBps: FEE_BPS,
    requestId,
    dealerName: 'Payoff fixed quote · Demo',
    signature: null,
    transaction: null,
    quote: {
      ...preview.order,
      requestId,
      dealer: DEALER,
      strikeAmountUSDG: preview.strikeAmountUSDG,
      grossPremiumUSDG: gross.toString(),
      protocolFeeUSDG: fee.toString(),
      netPremiumUSDG: (gross - fee).toString(),
      issuedAt: String(now),
      deadline: String(expired ? now - 1 : deadline),
      nonce: BigInt(`0x${crypto.randomUUID().replaceAll('-', '')}`).toString(),
    },
  };
}
export function openDemo(
  state: DemoState,
  preview: Preview,
  quote: DemoQuote,
  now = Math.floor(Date.now() / 1000),
): DemoState {
  const q = quote.quote;
  if (state.filledRequests.includes(quote.requestId))
    throw new UserFacingError('This demo quote has already been filled. Do not submit it again.');
  if (Number(q.deadline) <= now || Number(preview.series.tradeCutoff) <= now)
    throw new UserFacingError('The quote has expired. Please request a new quote.');
  if (
    q.vault !== preview.order.vault ||
    q.taker !== preview.order.taker ||
    q.seriesId !== preview.order.seriesId ||
    q.wrappedQuantity !== preview.wrappedQuantity ||
    q.strikeAmountUSDG !== preview.strikeAmountUSDG
  )
    throw new UserFacingError('The order has changed. Please request a new quote.');
  if (!isPrepared(state.balances, preview))
    throw new UserFacingError('Assets or allowances have changed. Please prepare your assets again.');
  const next = structuredClone(state),
    b = next.balances;
  if (preview.series.side === 0) {
    b.usdg = (BigInt(b.usdg) - BigInt(preview.strikeAmountUSDG)).toString();
    b.usdgAllowance = (BigInt(b.usdgAllowance) - BigInt(preview.strikeAmountUSDG)).toString();
  } else {
    b.wrapped = (BigInt(b.wrapped) - BigInt(preview.wrappedQuantity)).toString();
    b.wrappedAllowance = (BigInt(b.wrappedAllowance) - BigInt(preview.wrappedQuantity)).toString();
  }
  b.usdg = (BigInt(b.usdg) + BigInt(q.netPremiumUSDG)).toString();
  next.filledRequests.push(quote.requestId);
  next.positions.unshift({
    id: `demo-${crypto.randomUUID()}`,
    source: 'demo',
    account: q.taker,
    vault: q.vault,
    series: preview.series,
    wrappedQuantity: q.wrappedQuantity,
    strikeAmountUSDG: q.strikeAmountUSDG,
    netPremiumUSDG: q.netPremiumUSDG,
    entryRate: preview.rate,
    openedAt: now,
    status: 'open',
  });
  return next;
}
export function positionStatus(p: Position, now = Math.floor(Date.now() / 1000)) {
  return p.status === 'open' && now >= Number(p.series.exerciseEnd) ? 'expired' : p.status;
}
export function claimAmounts(position: Position, now = Math.floor(Date.now() / 1000)) {
  const status = positionStatus(position, now);
  if (status !== 'exercised' && status !== 'expired') return { usdg: '0', wrapped: '0' };
  const usd =
    (status === 'exercised' && position.series.side === 1) ||
    (status === 'expired' && position.series.side === 0);
  return { usdg: usd ? position.strikeAmountUSDG : '0', wrapped: usd ? '0' : position.wrappedQuantity };
}
export function claimDemo(state: DemoState, id: string): DemoState {
  const next = structuredClone(state),
    p = next.positions.find((p) => p.id === id);
  if (!p || !['exercised', 'expired'].includes(positionStatus(p)))
    throw new UserFacingError('This position is not claimable yet, or has already been claimed.');
  const receipt = claimAmounts(p);
  next.balances.usdg = (BigInt(next.balances.usdg) + BigInt(receipt.usdg)).toString();
  next.balances.wrapped = (BigInt(next.balances.wrapped) + BigInt(receipt.wrapped)).toString();
  p.outcome = positionStatus(p) as 'exercised' | 'expired';
  p.status = 'claimed';
  return next;
}
export class DemoAdapter implements ProductAdapter {
  readonly mode = 'demo' as const;
  private quotes = new Map<string, { fingerprint: string; result: DemoQuote }>();
  constructor(
    readonly storage: Storage,
    readonly account: Address = DEMO_ACCOUNT,
    private latency = 550,
  ) {}
  state() {
    return readDemoState(this.storage, this.account);
  }
  private save(state: DemoState) {
    this.storage.setItem(STORAGE_PREFIX + this.account.toLowerCase(), JSON.stringify(state));
  }
  async market() {
    const state = this.state();
    this.save(state);
    return demoMarket(state.anchor);
  }
  async balances() {
    return this.state().balances;
  }
  async quote(preview: Preview, key: string, scenario: Scenario = 'normal'): Promise<DemoQuote | null> {
    await wait(this.latency);
    if (scenario === 'offline')
      throw new UserFacingError(
        'The demo gateway is unavailable. Switch back to the normal scenario and try again.',
      );
    if (scenario === 'no-quote') return null;
    if (!isPrepared(this.state().balances, preview))
      throw new UserFacingError('Prepare your assets and approvals first.');
    if (Date.now() / 1000 >= Number(preview.series.tradeCutoff))
      throw new UserFacingError(
        'This series is closed to new positions. Reset the demo to create fresh series.',
      );
    const fingerprint = JSON.stringify(preview.order),
      prior = this.quotes.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new UserFacingError('The same request ID cannot be used for different orders.');
      return prior.result;
    }
    const result = createDemoQuote(preview, undefined, scenario === 'expired');
    this.quotes.set(key, { fingerprint, result });
    return result;
  }
  async prepare(quote: AppQuote): Promise<DemoQuote> {
    if (quote.kind !== 'demo') throw new UserFacingError('The quote environment does not match.');
    if (Number(quote.quote.deadline) <= Date.now() / 1000)
      throw new UserFacingError('The quote has expired. Please request a new quote.');
    return quote;
  }
  async prepareAssets(preview: Preview) {
    await wait(this.latency);
    this.save(prepareDemo(this.state(), preview));
  }
  async fill(preview: Preview, quote: DemoQuote, scenario: Scenario) {
    await wait(this.latency);
    if (scenario === 'rejected')
      throw new UserFacingError('Simulated cancellation. Assets were not locked. You can confirm again.');
    if (scenario === 'failed')
      throw new UserFacingError(
        'Simulated trade failure. No collateral was deducted and no position was created.',
      );
    const next = openDemo(this.state(), preview, quote);
    this.save(next);
    return next.positions[0];
  }
  async claim(id: string) {
    await wait(this.latency);
    this.save(claimDemo(this.state(), id));
  }
  simulateOutcome(id: string, outcome: 'exercised' | 'expired') {
    const next = this.state(),
      p = next.positions.find((p) => p.id === id);
    if (!p || positionStatus(p) !== 'open')
      throw new UserFacingError('Only open demo positions can switch outcomes.');
    // Explicit scenario override. Signed series terms remain unchanged; no chain time is changed.
    p.status = outcome;
    p.outcome = outcome;
    this.save(next);
  }
  reset() {
    this.quotes.clear();
    this.save(initialDemoState());
  }
}
