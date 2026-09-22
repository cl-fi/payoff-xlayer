import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { asGatewayError, within } from './errors.js';
import { Gateway, publicRecord } from './gateway.js';
import { hash, orderSchema } from './types.js';
import type { ReferenceSnapshot } from '../../sdk/catalog.mjs';

const keySchema = z.string().min(16).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
export async function buildApp(gateway: Gateway, logger = false, reference?: () => Promise<ReferenceSnapshot>) {
  const app = Fastify({ logger: logger ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.idempotency-key'] } : false,
    bodyLimit: 16384, trustProxy: gateway.config.trustedProxies.length ? gateway.config.trustedProxies : false,
    requestTimeout: gateway.config.requestTimeoutMs + 15000 });
  await app.register(cors, { origin: gateway.config.allowedOrigins, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Idempotency-Key'] });
  await app.register(rateLimit, { max: gateway.config.requestsPerMinute, timeWindow: '1 minute' });
  app.addHook('onSend', async (_req, reply, payload) => { reply.header('cache-control', 'no-store'); return payload; });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid request fields. Amounts must be decimal integer strings in token base units.' } });
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      const code = 'code' in error && typeof error.code === 'string' ? error.code : 'INVALID_REQUEST';
      return reply.code(error.statusCode).send({ error: { code, message: error.message } });
    }
    const safe = asGatewayError(error);
    // Do not log raw upstream errors: they can contain RPC credentials, headers or signatures.
    request.log.error({ code: safe.code, requestId: request.id }, 'gateway request failed');
    return reply.code(safe.statusCode).send({ error: { code: safe.code, message: safe.message } });
  });
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));
  app.get('/readyz', async () => {
    await within(Promise.all([gateway.store.health(), gateway.chain.health()]), gateway.config.requestTimeoutMs);
    return { status: 'ready', chainId: gateway.config.chainId, exchange: gateway.config.exchange };
  });
  app.get('/v1/markets', async () => ({ chainId: gateway.config.chainId, exchange: gateway.config.exchange,
    usdg: gateway.config.usdg, markets: gateway.config.markets, quantityUnit: 'wrapped-token-base-units', wrappedDecimals: 18, usdgDecimals: 6 }));
  app.get('/v1/reference-quotes', async (_request, reply) => {
    try {
      if (!reference) throw new Error('Reference source unavailable');
      return await reference();
    } catch { return reply.code(503).send({ error: { code: 'REFERENCE_UNAVAILABLE', message: 'Reference prices are temporarily unavailable.' } }); }
  });
  app.post('/v1/rfqs', async (request, reply) => {
    const key = keySchema.parse(request.headers['idempotency-key']);
    const order = orderSchema.parse(request.body);
    const result = await gateway.create(order, key);
    if (result.httpStatus === 202 || result.httpStatus === 503) reply.header('retry-after', '1');
    return reply.code(result.httpStatus).send(result.body);
  });
  app.get('/v1/rfqs/:requestId', async request => {
    const { requestId } = z.object({ requestId: hash }).parse(request.params);
    return publicRecord(await gateway.store.get(requestId));
  });
  app.post('/v1/rfqs/:requestId/prepare', async request => {
    const { requestId } = z.object({ requestId: hash }).parse(request.params);
    return gateway.prepare(requestId);
  });
  app.post('/v1/rfqs/:requestId/transactions', async request => {
    const { requestId } = z.object({ requestId: hash }).parse(request.params);
    const { transactionHash } = z.strictObject({ transactionHash: hash }).parse(request.body);
    return gateway.transaction(requestId, transactionHash);
  });
  return app;
}
