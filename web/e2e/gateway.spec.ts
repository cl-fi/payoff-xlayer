import { test, expect } from '@playwright/test';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import deployment from '../../config/xlayer-testnet.json' with { type: 'json' };
import { fixtureRpc, TEST_ACCOUNT, TEST_NOW } from '../test/testnet-fixture';
import { exchangeAbi, tokenAbi, vaultAbi, wrapperAbi } from '../src/lib/chain';

test('browser fetch reaches gateway directly; an unfunded offer never creates a position', async ({
  page,
}) => {
  const requested: string[] = [];
  await page.clock.setFixedTime(TEST_NOW);
  await page.route('https://gateway.example.test/**', async (route) => {
    requested.push(route.request().url());
    if (route.request().url().endsWith('/v1/markets')) await route.fulfill({ json: deployment });
    else if (route.request().url().endsWith('/v1/rfqs'))
      await route.fulfill({ status: 409, json: { error: { code: 'DEALER_BALANCE' } } });
    else throw new Error('Unexpected endpoint');
  });
  await page.route(deployment.rpcUrl, async (route) => {
    const request = route.request().postDataJSON();
    let result;
    if (request.method === 'eth_call') {
      const { functionName } = decodeFunctionData({
        abi: [...vaultAbi, ...tokenAbi, ...wrapperAbi, ...exchangeAbi],
        data: request.params[0].data,
      });
      if (functionName === 'nextPositionId')
        result = encodeFunctionResult({ abi: vaultAbi, functionName, result: 1n });
      if (functionName === 'allowance')
        result = encodeFunctionResult({ abi: tokenAbi, functionName, result: 10000000n });
    }
    await route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result: result ?? fixtureRpc(request) } });
  });
  await page.addInitScript((account) => {
    (window as any).ethereum = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
        if (method === 'eth_chainId') return '0x7a0';
        throw new Error('No transaction is allowed without a valid quote');
      },
      on() {},
      removeListener() {},
    };
  }, TEST_ACCOUNT);
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Choose an expiry' }).getByRole('button')).toHaveCount(2);
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Browser wallet', exact: true }).click();
  await page.getByLabel('Stock quantity').fill('0.001');
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Create order' }).getByRole('alert')).toContainText(
    'The dealer cannot fund this quote',
  );
  expect(requested.some((url) => url.endsWith('/v1/rfqs'))).toBe(true);
  await page.getByRole('link', { name: 'My positions', exact: true }).click();
  await expect(page.locator('.position-row')).toHaveCount(0);
});
