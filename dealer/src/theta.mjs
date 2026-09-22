import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { NoQuote } from './pricing.mjs';

export class ThetaProvider {
  ready = false;
  pending = new Map();
  closed = false;
  retryMs = 1000;
  constructor({ timeoutMs = 7000, python = process.env.THETA_PYTHON ?? 'python3' } = {}) {
    this.timeoutMs = timeoutMs; this.python = python;
    this.start();
  }
  start() {
    if (this.closed) return;
    const child = this.child = spawn(this.python, ['-u', fileURLToPath(new URL('../theta/worker.py', import.meta.url))], {
      // The market-data process never receives the wallet key or gateway credential.
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONUNBUFFERED: '1',
        THETADATA_API_KEY: process.env.THETADATA_API_KEY, POLARS_MAX_THREADS: '2' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const startup = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        if (line.length > 16384) throw new Error('Oversized worker response');
        const message = JSON.parse(line);
        if (message.ready === true) { clearTimeout(startup); this.ready = true; this.retryMs = 1000; return; }
        if (message.ready === false) { child.kill('SIGKILL'); return; }
        const job = this.pending.get(message.id);
        if (!job) return;
        clearTimeout(job.timer); this.pending.delete(message.id);
        if (message.error) job.reject(new NoQuote(/^[A-Z_]{1,60}$/.test(message.error) ? message.error : 'MARKET_DATA_UNAVAILABLE'));
        else job.resolve(message.market);
      } catch { child.kill('SIGKILL'); }
    });
    const stopped = () => {
      if (this.child !== child) return;
      clearTimeout(startup); lines.close(); this.child = null; this.ready = false;
      for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new NoQuote('MARKET_DATA_UNAVAILABLE')); }
      this.pending.clear();
      if (!this.closed) {
        this.restart = setTimeout(() => this.start(), this.retryMs);
        this.retryMs = Math.min(30000, this.retryMs * 2);
      }
    };
    child.on('error', stopped); child.on('exit', stopped);
  }
  async quote(option) {
    if (!this.ready || !this.child) throw new NoQuote('MARKET_DATA_UNAVAILABLE');
    if (this.pending.size >= 4) throw new NoQuote('MARKET_DATA_BUSY');
    const child = this.child;
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new NoQuote('MARKET_DATA_TIMEOUT'));
        this.ready = false; child.kill('SIGKILL');
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, option })}\n`);
    });
  }
  close() {
    this.closed = true; this.ready = false; clearTimeout(this.restart);
    this.child?.kill('SIGKILL');
  }
}
