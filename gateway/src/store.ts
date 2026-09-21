import { randomBytes, createHash } from 'node:crypto';
import type { Hex } from 'viem';
import { GatewayError } from './errors.js';
import type { DealerRequest, Order, Outcome, RfqResult, Settlement } from './types.js';

export interface Sql { query<T extends Record<string, any> = Record<string, any>>(text: string, params?: any[]): Promise<{ rows: T[] }> }
export const schema = `
CREATE TABLE IF NOT EXISTS gateway_rfqs (
  request_id text PRIMARY KEY,
  key_hash text UNIQUE NOT NULL,
  fingerprint text NOT NULL,
  input jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('collecting','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  processing_until timestamptz NOT NULL,
  context jsonb,
  audit jsonb NOT NULL DEFAULT '[]',
  result jsonb,
  http_status integer,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS gateway_rfqs_created ON gateway_rfqs(created_at);
CREATE TABLE IF NOT EXISTS gateway_transactions (
  request_id text NOT NULL REFERENCES gateway_rfqs(request_id),
  transaction_hash text NOT NULL,
  observation jsonb NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id,transaction_hash)
);`;
export type RecordRow = {
  request_id: Hex; fingerprint: string; input: Order; state: 'collecting' | 'completed';
  context: DealerRequest | null; result: RfqResult | null; http_status: number | null;
  processing_until: Date; audit: Outcome[];
};
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class Store {
  constructor(private sql: Sql) {}
  async migrate() { await this.sql.query(schema); }
  async health() { await this.sql.query('SELECT request_id FROM gateway_rfqs LIMIT 0'); }
  async claim(keyHash: string, input: Order, processMs: number): Promise<{ owned: boolean; row: RecordRow }> {
    const fingerprint = digest(JSON.stringify(input));
    const requestId = `0x${randomBytes(32).toString('hex')}`;
    const inserted = await this.sql.query<RecordRow>(`INSERT INTO gateway_rfqs
      (request_id,key_hash,fingerprint,input,state,processing_until) VALUES ($1,$2,$3,$4,'collecting',now()+($5 * interval '1 millisecond'))
      ON CONFLICT (key_hash) DO NOTHING RETURNING *`, [requestId, keyHash, fingerprint, JSON.stringify(input), processMs]);
    if (inserted.rows[0]) return { owned: true, row: inserted.rows[0] };
    const row = (await this.sql.query<RecordRow>('SELECT * FROM gateway_rfqs WHERE key_hash=$1', [keyHash])).rows[0]!;
    if (row.fingerprint !== fingerprint) throw new GatewayError('IDEMPOTENCY_CONFLICT', 'This idempotency key was used with a different order.', 409);
    return { owned: false, row: await this.expireInterrupted(row) };
  }
  async get(requestId: string) {
    const row = (await this.sql.query<RecordRow>('SELECT * FROM gateway_rfqs WHERE request_id=$1', [requestId])).rows[0];
    if (!row) throw new GatewayError('RFQ_NOT_FOUND', 'Unknown RFQ.', 404);
    return this.expireInterrupted(row);
  }
  private async expireInterrupted(row: RecordRow) {
    // Never silently reissue dealer requests after a process crash: old signatures may still exist.
    if (row.state === 'collecting') {
      const result: RfqResult = { requestId: row.request_id, status: 'failed', responses: [],
        error: { code: 'RFQ_INTERRUPTED', message: 'RFQ processing was interrupted. Start a new request with a new idempotency key.' } };
      const changed = await this.sql.query<RecordRow>(`UPDATE gateway_rfqs SET state='completed',result=$2,http_status=503,finished_at=now()
        WHERE request_id=$1 AND state='collecting' AND processing_until < now() RETURNING *`, [row.request_id, JSON.stringify(result)]);
      return changed.rows[0] ?? row;
    }
    return row;
  }
  async context(requestId: string, context: DealerRequest) {
    await this.sql.query('UPDATE gateway_rfqs SET context=$2 WHERE request_id=$1 AND state=\'collecting\'', [requestId, JSON.stringify(context)]);
  }
  async complete(requestId: string, result: RfqResult, audit: Outcome[], httpStatus: number) {
    const updated = await this.sql.query(`UPDATE gateway_rfqs SET state='completed',result=$2,audit=$3,http_status=$4,finished_at=now()
      WHERE request_id=$1 AND state='collecting' RETURNING request_id`, [requestId, JSON.stringify(result), JSON.stringify(audit), httpStatus]);
    if (!updated.rows.length) throw new GatewayError('RFQ_INTERRUPTED', 'RFQ ownership expired before completion.', 503);
  }
  async transaction(requestId: string, observation: Settlement) {
    await this.sql.query(`INSERT INTO gateway_transactions(request_id,transaction_hash,observation) VALUES ($1,$2,$3)
      ON CONFLICT(request_id,transaction_hash) DO UPDATE SET observation=excluded.observation,checked_at=now()`,
    [requestId, observation.transactionHash, JSON.stringify(observation)]);
  }
}
