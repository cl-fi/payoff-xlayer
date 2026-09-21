import { database } from './database.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const { pool, store } = database(process.env.DATABASE_URL);
try { await store.migrate(); console.log('Gateway schema is ready.'); }
finally { await pool.end(); }
