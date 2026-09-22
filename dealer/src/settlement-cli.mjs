import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';
import { configSchema } from './config.mjs';
import { SettlementChain, SettlementError } from './settlement-chain.mjs';
import { settlementStatus } from './settlement.mjs';
import { ManualSettlement } from './settlement-manual.mjs';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    vault: { type: 'string' }, position: { type: 'string' }, asset: { type: 'string' }, amount: { type: 'string' }, execute: { type: 'boolean', default: false },
  } });
  const [command] = positionals;
  if (positionals.length !== 1 || !['status', 'exercise', 'approve', 'reconcile', 'rebroadcast'].includes(command))
    throw new SettlementError('USAGE: status | exercise --vault ADDRESS --position ID [--execute] | approve --vault ADDRESS --asset usdg|wrapped --amount BASE_UNITS [--execute] | reconcile | rebroadcast --execute');
  const config = configSchema.parse(JSON.parse(await readFile(process.env.DEALER_CONFIG_PATH ?? 'config.local.json', 'utf8')));
  if (!/^0x[\da-fA-F]{64}$/.test(process.env.DEALER_PRIVATE_KEY ?? '') || !process.env.XLAYER_RPC_URL)
    throw new SettlementError('MISSING_SETTLEMENT_CREDENTIALS');
  const account = privateKeyToAccount(process.env.DEALER_PRIVATE_KEY);
  const chain = new SettlementChain(config, process.env.XLAYER_RPC_URL, account.address);
  const manual = new ManualSettlement({ chain, account, path: process.env.DEALER_SETTLEMENT_TX_PATH ?? 'data/settlement-transactions.json' });
  let result;
  if (command === 'status') result = settlementStatus(await chain.snapshot(), config);
  else if (command === 'reconcile') result = await manual.reconcile();
  else if (command === 'rebroadcast') {
    if (!values.execute) throw new SettlementError('REBROADCAST_REQUIRES_EXECUTE');
    result = await manual.rebroadcast();
  } else {
    if (!values.vault || (command === 'exercise' && !values.position)) throw new SettlementError('MISSING_TARGET');
    const action = command === 'exercise' ? { kind: command, vault: values.vault, positionId: values.position }
      : { kind: command, vault: values.vault, asset: values.asset, amount: values.amount };
    result = values.execute ? await manual.execute(action) : { status: 'preview', plan: await manual.plan(action) };
  }
  console.log(JSON.stringify(result, null, 2));
  if (['blocked', 'broadcast_uncertain', 'nonce_consumed_needs_review'].includes(result.status)) process.exitCode = 2;
}
main().catch(error => {
  // Never emit RPC errors, environment values or raw signed transactions.
  console.error(JSON.stringify({ error: error instanceof SettlementError ? error.code : 'SETTLEMENT_COMMAND_FAILED' })); process.exitCode = 1;
});
