import { open, readFile, unlink } from 'node:fs/promises';
import { encodeFunctionData, keccak256 } from 'viem';
import { savePrivate } from './settlement.mjs';
import { SettlementError, jsonSafe, settlementTokenAbi, settlementVaultAbi } from './settlement-chain.mjs';

const fail = code => { throw new SettlementError(code); };
const publicRecord = record => record ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'raw')) : null;

// Only the explicit CLI uses this signer. The monitor has no transaction methods.
// Persist the signed transaction before broadcasting so an uncertain RPC response
// can only be retried as the SAME hash/nonce, never as a second exercise.
export class ManualSettlement {
  constructor({ chain, account, path }) { Object.assign(this, { chain, account, path }); }
  async locked(fn) {
    // Ensure the parent exists without ever replacing an existing journal.
    const { mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const path = `${this.path}.lock`;
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { handle = await open(path, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number(await readFile(path, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) fail('TRANSACTION_LOCKED');
        try { process.kill(pid, 0); fail('TRANSACTION_LOCKED'); }
        catch (e) { if (e.code !== 'ESRCH') throw e; }
        // Previous CLI crashed. Its durable transaction must still be reconciled.
        await unlink(path);
      }
    }
    if (!handle) fail('TRANSACTION_LOCKED');
    try { await handle.writeFile(String(process.pid)); await handle.sync(); return await fn(); }
    finally { await handle.close(); await unlink(path); }
  }
  async load() {
    let state;
    try { state = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') fail('INVALID_TX_JOURNAL');
      return { version: 1, chainId: this.chain.config.chainId, dealer: this.account.address, pending: null, history: [] };
    }
    if (state.version !== 1 || state.chainId !== this.chain.config.chainId
      || state.dealer?.toLowerCase() !== this.account.address.toLowerCase() || !Array.isArray(state.history)
      || (state.pending && keccak256(state.pending.raw) !== state.pending.hash)) fail('INVALID_TX_JOURNAL');
    return state;
  }
  async reconcileState(state) {
    if (!state.pending) return { status: 'idle' };
    await this.chain.block();
    let receipt;
    try { receipt = await this.chain.client.getTransactionReceipt({ hash: state.pending.hash }); }
    catch (error) {
      if (error.name !== 'TransactionReceiptNotFoundError') fail('RECEIPT_LOOKUP_FAILED');
      const nonce = await this.chain.client.getTransactionCount({ address: this.account.address, blockTag: 'latest' });
      return { status: nonce > state.pending.nonce ? 'nonce_consumed_needs_review' : 'pending', transaction: publicRecord(state.pending) };
    }
    const latest = await this.chain.client.getBlockNumber({ cacheTime: 0 });
    if (latest - receipt.blockNumber + 1n < BigInt(this.chain.config.settlementConfirmations))
      return { status: 'confirming', transaction: publicRecord(state.pending) };
    const record = { ...publicRecord(state.pending), status: receipt.status, blockNumber: String(receipt.blockNumber), confirmedAt: new Date().toISOString() };
    state.history.push(record); state.pending = null;
    await savePrivate(this.path, state);
    return { status: record.status, transaction: record };
  }
  reconcile() { return this.locked(async () => this.reconcileState(await this.load())); }
  async plan(action) {
    let plan, call;
    if (action.kind === 'exercise') {
      plan = await this.chain.exercisePlan(action.vault, action.positionId);
      call = { address: plan.vault, abi: settlementVaultAbi, functionName: 'exercise', args: [BigInt(action.positionId)] };
    } else if (action.kind === 'approve') {
      if (!['usdg', 'wrapped'].includes(action.asset) || !/^(0|[1-9][0-9]*)$/.test(action.amount ?? '') || BigInt(action.amount) >= 2n ** 256n)
        fail('INVALID_APPROVAL');
      const market = this.chain.market(action.vault), block = await this.chain.block();
      await this.chain.validate(market, block.number);
      const token = action.asset === 'usdg' ? this.chain.config.usdg : market.wrappedStock;
      const allowance = await this.chain.read(token, settlementTokenAbi, 'allowance', [this.account.address, market.vault], block.number);
      call = { address: token, abi: settlementTokenAbi, functionName: 'approve', args: [market.vault, BigInt(action.amount)] };
      plan = { action: 'approve', chainId: this.chain.config.chainId, dealer: this.account.address,
        vault: market.vault, token, asset: action.asset, currentAllowance: String(allowance), newAllowance: action.amount, issues: [] };
    } else fail('UNKNOWN_ACTION');
    if (plan.issues.length) return plan;
    try {
      const [gas, gasPrice, gasBalance] = await Promise.all([
        this.chain.client.estimateContractGas({ ...call, account: this.account }),
        this.chain.client.getGasPrice(), this.chain.client.getBalance({ address: this.account.address }),
      ]);
      await this.chain.client.simulateContract({ ...call, account: this.account });
      const limit = (gas * 120n + 99n) / 100n, price = (gasPrice * 120n + 99n) / 100n;
      if (gasBalance < limit * price) plan.issues.push('INSUFFICIENT_GAS');
      return jsonSafe({ ...plan, transaction: { to: call.address, data: encodeFunctionData(call), gas: limit, gasPrice: price, value: '0' },
        maximumGasCostWei: limit * price });
    } catch { return { ...plan, issues: [...plan.issues, 'SIMULATION_FAILED'] }; }
  }
  execute(action) {
    return this.locked(async () => {
      const state = await this.load();
      const previous = await this.reconcileState(state);
      if (state.pending) return { status: 'blocked', reason: 'PREVIOUS_TRANSACTION_UNRESOLVED', previous };
      const plan = await this.plan(action);
      if (plan.issues.length) return { status: 'blocked', plan };
      const [nonce, pendingNonce] = await Promise.all(['latest', 'pending'].map(blockTag =>
        this.chain.client.getTransactionCount({ address: this.account.address, blockTag })));
      if (nonce !== pendingNonce) fail('WALLET_HAS_PENDING_TRANSACTION');
      if (action.kind === 'exercise' && Date.now() >= Number(plan.position.terms.exerciseEnd) * 1000) fail('WINDOW_ENDED');
      const tx = plan.transaction;
      const raw = await this.account.signTransaction({ chainId: this.chain.config.chainId, nonce, type: 'legacy',
        to: tx.to, data: tx.data, value: 0n, gas: BigInt(tx.gas), gasPrice: BigInt(tx.gasPrice) });
      state.pending = { action, hash: keccak256(raw), raw, nonce, createdAt: new Date().toISOString() };
      await savePrivate(this.path, state);
      return this.broadcast(state);
    });
  }
  async broadcast(state) {
    try { await this.chain.client.sendRawTransaction({ serializedTransaction: state.pending.raw }); }
    catch { return { status: 'broadcast_uncertain', transaction: publicRecord(state.pending), next: 'reconcile; never send a new nonce blindly' }; }
    try {
      await this.chain.client.waitForTransactionReceipt({ hash: state.pending.hash,
        confirmations: this.chain.config.settlementConfirmations, timeout: 45000, pollingInterval: 1000 });
      return await this.reconcileState(state);
    } catch { return { status: 'pending', transaction: publicRecord(state.pending), next: 'reconcile' }; }
  }
  rebroadcast() {
    return this.locked(async () => {
      const state = await this.load(), result = await this.reconcileState(state);
      if (!state.pending || result.status !== 'pending') return result;
      // Revalidate current eligibility before resending the exact saved transaction.
      const plan = await this.plan(state.pending.action);
      if (plan.issues.length) return { status: 'blocked', plan, transaction: publicRecord(state.pending) };
      return this.broadcast(state);
    });
  }
}
