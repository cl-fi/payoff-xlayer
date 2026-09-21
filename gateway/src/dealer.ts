import type { Dealer } from './config.js';
import { GatewayError } from './errors.js';
import { dealerResponseSchema, type DealerRequest } from './types.js';

/** The gateway only transports quotes. It has no pricing model, signer or dealer fund reservation. */
export async function requestDealer(dealer: Dealer, request: DealerRequest, token: string | undefined, signal: AbortSignal) {
  const response = await fetch(dealer.url, { method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(request),
  });
  if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    await response.body?.cancel();
    throw new GatewayError('DEALER_HTTP_ERROR', 'Dealer did not return a successful JSON response.', 502);
  }
  // Bound streaming responses as well as Content-Length; a bad dealer cannot exhaust gateway memory.
  const reader = response.body?.getReader();
  if (!reader) throw new GatewayError('DEALER_RESPONSE', 'Empty dealer response.', 502);
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) throw new GatewayError('DEALER_RESPONSE_TOO_LARGE', 'Dealer response exceeded the transport limit.', 502);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const parsed = dealerResponseSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (!parsed.success) throw new GatewayError('DEALER_RESPONSE', 'Dealer returned an invalid quote envelope.', 502);
  return parsed.data;
}
