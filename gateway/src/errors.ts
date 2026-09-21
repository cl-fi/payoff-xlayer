export class GatewayError extends Error {
  constructor(public code: string, message: string, public statusCode = 422) { super(message); }
}
export function asGatewayError(error: unknown): GatewayError {
  return error instanceof GatewayError ? error : new GatewayError('UPSTREAM_UNAVAILABLE', 'A required service is unavailable; retry with a new idempotency key.', 503);
}
export async function within<T>(operation: Promise<T>, ms: number, code = 'REQUEST_TIMEOUT'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new GatewayError(code, 'Operation timed out.', 503)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
