import { createWalletClient, custom, encodeFunctionData, parseEventLogs, type Address, type Hex } from 'viem';
import { UserFacingError } from './errors';
import {
  chainConfig,
  expectedFillData,
  fillEvent,
  publicClient,
  readBalances,
  tokenAbi,
  vaultAbi,
  wrapperAbi,
} from './chain';
import { activityKey, readActivity, saveActivity, type Activity } from './activity';
import { validateSelection, GatewayAdapter } from './data/gateway';
import { isPrepared, type Storage } from './data/demo';
import type { Config } from './config';
import type { Connection } from './wallet';
import type { GatewayQuote, Market, Position, Preview } from './types';

export class TradingWallet {
  readonly client;
  constructor(
    readonly config: Config,
    readonly connection: Connection,
    readonly storage: Storage,
    readonly progress: (message: string) => void,
    readonly guard: () => void = () => {},
    client = publicClient(config),
  ) {
    this.client = client;
  }
  async check() {
    this.guard();
    if (this.config.mode !== 'gateway' || this.connection.kind !== 'wallet')
      throw new UserFacingError('Connect a wallet to trade on X Layer Testnet.');
    const [accounts, chainId] = await Promise.all([
      this.connection.provider.request({ method: 'eth_accounts' }),
      this.connection.provider.request({ method: 'eth_chainId' }),
    ]);
    this.guard();
    if (accounts[0]?.toLowerCase() !== this.connection.address.toLowerCase())
      throw new UserFacingError('Your wallet account changed. Review the order again.');
    if (Number(chainId) !== this.config.chainId)
      throw new UserFacingError('Switch your wallet to X Layer Testnet before continuing.');
    if (
      readActivity(this.storage, this.config, this.connection.address).some((tx) => tx.status === 'pending')
    )
      throw new UserFacingError(
        'A submitted transaction is still pending. Check its status before starting another action.',
      );
  }
  async send(to: Address, data: Hex, kind: Activity['kind'], label: string, requestId?: Hex) {
    await this.check();
    const account = this.connection.address;
    const gas = await this.client.estimateGas({ account, to, data, value: 0n });
    await this.check();
    if (this.connection.kind !== 'wallet') throw new Error('Wallet required');
    // Verify storage before opening the wallet so a blocked browser store cannot lose a submitted hash.
    const key = activityKey(this.config, account);
    try {
      this.storage.setItem(key, JSON.stringify(readActivity(this.storage, this.config, account)));
    } catch {
      throw new UserFacingError('Enable browser storage before submitting a transaction.');
    }
    this.progress(`Confirm ${label.toLowerCase()} in your wallet…`);
    const wallet = createWalletClient({
      chain: chainConfig(this.config),
      transport: custom(this.connection.provider),
      account,
    });
    const hash = await wallet.sendTransaction({ to, data, value: 0n, gas: (gas * 120n) / 100n });
    let item: Activity = {
      hash,
      account,
      to,
      data,
      value: '0',
      kind,
      label,
      requestId,
      status: 'pending',
      createdAt: Date.now(),
    };
    try {
      saveActivity(this.storage, this.config, item);
    } catch {
      throw new UserFacingError(
        `Transaction submitted, but the browser could not save its status. Check your wallet before retrying. Transaction: ${hash}`,
      );
    }
    this.progress(`${label} submitted. Waiting for confirmation…`);
    const receipt = await this.client
      .waitForTransactionReceipt({
        hash,
        confirmations: 2,
        timeout: 120000,
        pollingInterval: 1000,
        onReplaced: ({ transaction, transactionReceipt }) => {
          const previousHash = item.hash;
          const same =
            transaction.from.toLowerCase() === account.toLowerCase() &&
            transaction.to?.toLowerCase() === to.toLowerCase() &&
            transaction.input === data &&
            transaction.value === 0n;
          item = {
            ...item,
            hash: transactionReceipt.transactionHash,
            status: same ? 'pending' : 'cancelled',
          };
          saveActivity(this.storage, this.config, item, previousHash);
        },
      })
      .catch(() => {
        throw new UserFacingError(
          `Transaction submitted. Confirmation is still pending. Use Check status or your wallet activity before retrying. Transaction: ${item.hash}`,
        );
      });
    item.status =
      item.status === 'cancelled' ? 'cancelled' : receipt.status === 'success' ? 'confirmed' : 'reverted';
    saveActivity(this.storage, this.config, item);
    if (item.status !== 'confirmed')
      throw new UserFacingError(
        item.status === 'cancelled'
          ? 'The transaction was cancelled or replaced with another action.'
          : 'The transaction reverted. Your position was not changed.',
      );
    return receipt;
  }
  async approve(token: Address, spender: Address, amount: bigint, label: string) {
    const allowance = await this.client.readContract({
      address: token,
      abi: tokenAbi,
      functionName: 'allowance',
      args: [this.connection.address, spender],
    });
    if (allowance < amount)
      await this.send(
        token,
        encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [spender, amount] }),
        'approval',
        label,
      );
  }
  async prepareAssets(preview: Preview, market: Market) {
    await this.check();
    if (
      preview.order.taker.toLowerCase() !== this.connection.address.toLowerCase() ||
      preview.order.vault.toLowerCase() !== this.config.nvdaVault.toLowerCase()
    )
      throw new UserFacingError('The order does not match this wallet and Vault. Review it again.');
    const b = await readBalances(
      this.config,
      this.connection.address,
      market,
      preview.order.vault,
      this.client,
    );
    if (BigInt(b.okb ?? '0') === 0n) throw new UserFacingError('You need test OKB for transaction fees.');
    if (preview.series.side === 0) {
      if (BigInt(b.usdg) < BigInt(preview.strikeAmountUSDG))
        throw new UserFacingError('Insufficient test USDG. Reduce the quantity or fund your wallet.');
      await this.approve(market.usdg, preview.order.vault, BigInt(preview.strikeAmountUSDG), 'USDG approval');
    } else {
      const shortfall = BigInt(preview.wrappedQuantity) - BigInt(b.wrapped);
      if (shortfall > 0n) {
        const assets = await this.client.readContract({
          address: market.wrappedStock,
          abi: wrapperAbi,
          functionName: 'previewMint',
          args: [shortfall],
        });
        if (BigInt(b.stock) < assets)
          throw new UserFacingError(
            'Insufficient test NVDAx to wrap. Reduce the quantity or fund your wallet.',
          );
        await this.approve(market.stock, market.wrappedStock, assets, 'NVDAx wrapping approval');
        await this.send(
          market.wrappedStock,
          encodeFunctionData({
            abi: wrapperAbi,
            functionName: 'mint',
            args: [shortfall, this.connection.address],
          }),
          'wrap',
          'Stock wrapping',
        );
      }
      await this.approve(
        market.wrappedStock,
        preview.order.vault,
        BigInt(preview.wrappedQuantity),
        'Wrapped stock approval',
      );
    }
    const actual = await readBalances(
      this.config,
      this.connection.address,
      market,
      preview.order.vault,
      this.client,
    );
    if (!isPrepared(actual, preview))
      throw new UserFacingError('Balances or allowances changed. Refresh and prepare the remaining amount.');
  }
  async fill(adapter: GatewayAdapter, preview: Preview, original: GatewayQuote, market: Market) {
    await this.check();
    const checked = await adapter.prepare(original);
    validateSelection(checked.selection, preview, market);
    if (Number(checked.selection.quote.deadline) * 1000 <= Date.now() + 3000)
      throw new UserFacingError('The quote is expiring. Request a new quote.');
    const receipt = await this.send(
      market.exchange,
      expectedFillData(checked, preview),
      'fill',
      'Position opening',
      checked.requestId as Hex,
    );
    const event = parseEventLogs({ abi: [fillEvent], logs: receipt.logs, strict: true }).find(
      (e) =>
        e.address.toLowerCase() === market.exchange.toLowerCase() && e.args.requestId === checked.requestId,
    );
    if (
      !event ||
      event.args.taker.toLowerCase() !== this.connection.address.toLowerCase() ||
      event.args.vault.toLowerCase() !== preview.order.vault.toLowerCase()
    )
      throw new UserFacingError('The transaction was mined. Refresh My positions to check its outcome.');
    // Chain receipt is authoritative even if the receipt-reporting endpoint is temporarily down.
    await adapter.settlement(checked.requestId, receipt.transactionHash).catch(() => {});
    return {
      id: String(event.args.positionId),
      source: 'gateway',
      account: this.connection.address,
      vault: preview.order.vault,
      series: preview.series,
      wrappedQuantity: preview.wrappedQuantity,
      strikeAmountUSDG: preview.strikeAmountUSDG,
      netPremiumUSDG: String(event.args.netPremiumUSDG),
      entryRate: preview.rate,
      openedAt: Math.floor(Date.now() / 1000),
      status: 'open',
      transactionHash: receipt.transactionHash,
    } satisfies Position;
  }
  async claim(position: Position) {
    await this.check();
    if (
      position.source !== 'gateway' ||
      position.account.toLowerCase() !== this.connection.address.toLowerCase() ||
      position.vault.toLowerCase() !== this.config.nvdaVault.toLowerCase()
    )
      throw new UserFacingError('The position does not belong to this wallet and Vault.');
    return this.send(
      position.vault,
      encodeFunctionData({ abi: vaultAbi, functionName: 'claim', args: [BigInt(position.id)] }),
      'claim',
      'Asset claim',
    );
  }
}
