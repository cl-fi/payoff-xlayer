import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decodeFunctionData } from 'viem';
import { Gateway, compareQuotes } from '../src/gateway.js';
import { buildApp } from '../src/app.js';
import { exchangeAbi } from '../src/chain.js';
import { GatewayError } from '../src/errors.js';
import { configSchema } from '../src/config.js';
import { orderSchema } from '../src/types.js';
import { config, db, dealer, dealerServer, fakeChain, json, makerA, makerB, order, signed, txHash, vault } from './helpers.js';
import type { ReferenceSnapshot } from '../../sdk/catalog.mjs';

test('public references bypass taker checks and maker collection; failures are isolated from the gateway', async t => {
  const database = await db(); t.after(database.close);
  const chain = fakeChain();
  chain.snapshot = async () => { throw new Error('References must not query taker state'); };
  const gateway = new Gateway(config([]), chain, database.store);
  let fail = false;
  const snapshot = { version: 1, chainId: 1952, exchange: gateway.config.exchange, updatedAtMs: Date.now(),
    catalogGeneratedAt: new Date().toISOString(), refreshIntervalMs: 30000, maxQuoteAgeMs: 30000, markets: [], quotes: [] } as ReferenceSnapshot;
  const app = await buildApp(gateway, false, async () => { if (fail) throw new Error('Private provider credential'); return snapshot; });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/v1/reference-quotes' });
  assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), snapshot);
  fail = true;
  const unavailable = await app.inject({ method: 'GET', url: '/v1/reference-quotes' });
  assert.equal(unavailable.statusCode, 503); assert.ok(!unavailable.body.includes('credential'));
  assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
});

test('parallel HTTP fanout selects highest net premium; one failed dealer does not block others', async t => {
  const database = await db(); t.after(database.close);
  const requests: any[] = [];
  let secondStarted!: () => void;
  const concurrent = new Promise<void>(resolve => { secondStarted = resolve; });
  // The first dealer cannot answer until the second is contacted. Sequential fanout fails this test.
  const a = await dealerServer(async (r, res, authorization) => { requests.push(r); assert.equal(authorization, 'Bearer internal-secret'); await concurrent; json(res, { status: 'quote', ...await signed(r) }); });
  const b = await dealerServer(async (r, res) => { requests.push(r); secondStarted(); json(res, { status: 'quote', ...await signed(r, '3000000', makerB) }); });
  const c = await dealerServer((_r, res) => { res.writeHead(500); res.end('broken'); });
  t.after(a.close); t.after(b.close); t.after(c.close);
  const cfg = config([dealer('a', a.url), dealer('b', b.url, makerB), { ...dealer('c', c.url), address: '0x0000000000000000000000000000000000000060' }]);
  const gateway = new Gateway(cfg, fakeChain(), database.store, new Map([['a', 'internal-secret']]));
  const app = await buildApp(gateway); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/rfqs', headers: { 'idempotency-key': randomUUID() }, payload: order });
  assert.equal(response.statusCode, 200);
  const result = response.json();
  assert.equal(result.selection.dealerId, 'b'); assert.equal(result.selection.quote.netPremiumUSDG, '2970000');
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(result.responses.find((r: any) => r.dealerId === 'c').status, 'rejected');
  assert.equal(result.responses[0].signedQuote, undefined);
  const decoded = decodeFunctionData({ abi: exchangeAbi, data: result.selection.transaction.data });
  assert.equal(decoded.functionName, 'fill');
  if (decoded.functionName === 'fill') {
    assert.equal(decoded.args[2].minNetPremiumUSDG, 2970000n); assert.equal(decoded.args[2].maxCollateralUSDG, 180000000n);
    assert.equal(decoded.args[2].maxCollateralWrapped, 0n);
  }
  const persisted = await database.store.get(result.requestId);
  assert.equal(persisted.audit.filter(a => a.status === 'valid').length, 2); assert.ok(persisted.context);
});

test('idempotency survives concurrent requests and application restarts; conflicting body is rejected', async t => {
  const database = await db(); t.after(database.close); let calls = 0;
  const server = await dealerServer(async (r, res) => { calls++; await new Promise(r => setTimeout(r, 80)); json(res, { status: 'quote', ...await signed(r) }); }); t.after(server.close);
  const cfg = config([dealer('a', server.url)]);
  const gateway = new Gateway(cfg, fakeChain(), database.store);
  const key = randomUUID();
  const results = await Promise.all([gateway.create(order, key), gateway.create(order, key)]);
  assert.equal(calls, 1); assert.deepEqual(results.map(r => r.httpStatus).sort(), [200, 202]);
  const complete = results.find(r => r.httpStatus === 200)!;
  const restarted = new Gateway(cfg, fakeChain(), database.store);
  assert.deepEqual(await restarted.create(order, key), complete); assert.equal(calls, 1);
  await assert.rejects(restarted.create({ ...order, wrappedQuantity: '2' }, key), (e: GatewayError) => e.code === 'IDEMPOTENCY_CONFLICT');
});

test('deadline bounds a hanging dealer without losing the valid quote', async t => {
  const database = await db(); t.after(database.close);
  const good = await dealerServer(async (r, res) => json(res, { status: 'quote', ...await signed(r) })); t.after(good.close);
  const slow = await dealerServer(() => {}); t.after(slow.close);
  const cfg = config([dealer('a', good.url), dealer('b', slow.url, makerB)]); cfg.collectMs = 120;
  const result = await new Gateway(cfg, fakeChain(), database.store).create(order, randomUUID());
  assert.equal(result.body.status, 'quoted');
  assert.ok('responses' in result.body && result.body.responses.some(r => r.dealerId === 'b' && r.status === 'timeout'));
});

test('unbacked higher bid is rejected; lower executable bid wins before user confirmation', async t => {
  const database = await db(); t.after(database.close);
  const a = await dealerServer(async (r, res) => json(res, { status: 'quote', ...await signed(r, '999000000') })); t.after(a.close);
  const b = await dealerServer(async (r, res) => json(res, { status: 'quote', ...await signed(r, '2000000', makerB) })); t.after(b.close);
  const chain = fakeChain(); chain.validate = async (_r, s) => { if (s.quote.dealer === makerA.address) throw new GatewayError('DEALER_BALANCE', 'Insufficient balance.'); return { blockNumber: '11' }; };
  const result = await new Gateway(config([dealer('a', a.url), dealer('b', b.url, makerB)]), chain, database.store).create(order, randomUUID());
  assert.equal((result.body as any).selection.dealerId, 'b');
});

test('changed terms and fee manipulation never enter ranking', async t => {
  const database = await db(); t.after(database.close);
  const a = await dealerServer(async (r, res) => json(res, { status: 'quote', ...await signed(r, '2000000', makerA, { wrappedQuantity: '2' }) })); t.after(a.close);
  const b = await dealerServer(async (r, res) => json(res, { status: 'quote', ...await signed(r, '2000000', makerB, { netPremiumUSDG: '2000000' }) })); t.after(b.close);
  let validations = 0; const chain = fakeChain(); chain.validate = async () => { validations++; return { blockNumber: '11' }; };
  const result = await new Gateway(config([dealer('a', a.url), dealer('b', b.url, makerB)]), chain, database.store).create(order, randomUUID());
  assert.equal(result.body.status, 'no_quote'); assert.equal(validations, 0);
  assert.deepEqual((result.body as any).responses.map((r: any) => r.code).sort(), ['QUOTE_FEES', 'QUOTE_TERMS']);
});

test('taker preparation fails before any maker is contacted', async t => {
  const database = await db(); t.after(database.close); let calls = 0;
  const server = await dealerServer(() => { calls++; }); t.after(server.close);
  const chain = fakeChain(); chain.takerReady = async () => { throw new GatewayError('TAKER_ALLOWANCE', 'Approve the Vault first.'); };
  const result = await new Gateway(config([dealer('a', server.url)]), chain, database.store).create(order, randomUUID());
  assert.equal(result.httpStatus, 422); assert.equal(calls, 0);
});

test('prepare revalidates the same selected quote; it never silently substitutes a different quote', async t => {
  const database = await db(); t.after(database.close);
  const server = await dealerServer(async (r, res) => json(res, { status: 'quote', ...await signed(r) })); t.after(server.close);
  const chain = fakeChain(); const gateway = new Gateway(config([dealer('a', server.url)]), chain, database.store);
  const result = await gateway.create(order, randomUUID());
  chain.validate = async () => { throw new GatewayError('NONCE_UNAVAILABLE', 'Cancelled.'); };
  await assert.rejects(gateway.prepare(result.body.requestId), (e: GatewayError) => e.code === 'NONCE_UNAVAILABLE');
});

test('expired stored quotes cannot be prepared; repeated key never produces a replacement signature', async t => {
  const database = await db(); t.after(database.close); let calls = 0;
  const server = await dealerServer(async (r, res) => { calls++; json(res, { status: 'quote', ...await signed(r) }); }); t.after(server.close);
  const gateway = new Gateway(config([dealer('a', server.url)]), fakeChain(), database.store);
  const key = randomUUID(); const result = await gateway.create(order, key);
  await database.sql.query(`UPDATE gateway_rfqs SET result=jsonb_set(result,'{selection,quote,deadline}','"1"'::jsonb) WHERE request_id=$1`, [result.body.requestId]);
  const replay = await gateway.create(order, key);
  assert.equal(replay.body.status, 'expired'); assert.equal((replay.body as any).selection.transaction, null); assert.equal(calls, 1);
  await assert.rejects(gateway.prepare(result.body.requestId), (e: GatewayError) => e.code === 'QUOTE_EXPIRED');
});

test('abandoned RFQ is marked interrupted, never silently reissued after restart', async t => {
  const database = await db(); t.after(database.close);
  const claimed = await database.store.claim('some-key', order, 10);
  await database.sql.query(`UPDATE gateway_rfqs SET processing_until=now()-interval '1 second' WHERE request_id=$1`, [claimed.row.request_id]);
  const row = await database.store.get(claimed.row.request_id);
  assert.equal(row.result?.error?.code, 'RFQ_INTERRUPTED');
});

test('HTTP validation rejects numeric token amounts, extra fields, missing idempotency and unknown records', async t => {
  const database = await db(); t.after(database.close);
  const app = await buildApp(new Gateway(config(), fakeChain(), database.store)); t.after(() => app.close());
  for (const payload of [{ ...order, wrappedQuantity: 1e18 }, { ...order, seriesId: '01' }, { ...order, dealerUrl: 'http://attacker.invalid' }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/rfqs', headers: { 'idempotency-key': randomUUID() }, payload })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/v1/rfqs', payload: order })).statusCode, 400);
  assert.equal((await app.inject(`/v1/rfqs/${txHash}`)).statusCode, 404);
  assert.equal((await app.inject('/healthz')).json().status, 'ok');
  assert.equal((await app.inject('/readyz')).json().status, 'ready');
  assert.equal((await app.inject('/v1/markets')).json().markets[0].vault, vault);
});

test('transaction submission is not treated as a successful fill', async t => {
  const database = await db(); t.after(database.close);
  const server = await dealerServer(async (r, res) => json(res, { status: 'quote', ...await signed(r) })); t.after(server.close);
  const gateway = new Gateway(config([dealer('a', server.url)]), fakeChain(), database.store);
  const { body } = await gateway.create(order, randomUUID());
  assert.equal((await gateway.transaction(body.requestId, txHash)).status, 'pending');
});

test('tie-break uses maker address, not timing or self-operated label', () => {
  const a = { quote: { netPremiumUSDG: '10', dealer: makerA.address } } as any;
  const b = { quote: { netPremiumUSDG: '10', dealer: makerB.address } } as any;
  assert.equal(Math.sign(compareQuotes(a, b)), Math.sign(makerA.address.toLowerCase().localeCompare(makerB.address.toLowerCase())));
});

test('configuration rejects duplicates, unapproved HTTP and credential-bearing URLs', () => {
  const d = dealer('a', 'http://127.0.0.1:8000/quote');
  assert.throws(() => configSchema.parse({ ...config(), dealers: [d, d] }));
  assert.throws(() => configSchema.parse({ ...config(), dealers: [{ ...d, allowHttp: false }] }));
  assert.throws(() => configSchema.parse({ ...config(), dealers: [{ ...d, url: 'https://user:pass@example.com/quote' }] }));
  assert.throws(() => orderSchema.parse({ ...order, wrappedQuantity: (1n << 256n).toString() }));
});

test('streamed oversized and malformed responses are isolated', async t => {
  const database = await db(); t.after(database.close);
  const a = await dealerServer((_r, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('x'.repeat(70000)); }); t.after(a.close);
  const b = await dealerServer((_r, res) => json(res, { status: 'no_quote', reason: 'No inventory' })); t.after(b.close);
  const result = await new Gateway(config([dealer('a', a.url), dealer('b', b.url, makerB)]), fakeChain(), database.store).create(order, randomUUID());
  assert.equal(result.body.status, 'no_quote');
  assert.equal((result.body as any).responses.find((r: any) => r.dealerId === 'a').code, 'DEALER_RESPONSE_TOO_LARGE');
});
