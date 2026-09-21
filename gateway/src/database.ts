import pg from 'pg';
import { Store } from './store.js';
export function database(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    statement_timeout: 10000, application_name: 'payoff-rfq-gateway' });
  // Pool errors otherwise become uncaught exceptions. Never print connection strings.
  pool.on('error', () => console.error('PostgreSQL connection error; subsequent requests will retry through the pool.'));
  return { pool, store: new Store(pool) };
}
