import { test, expect } from '@playwright/test';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import deployment from '../../config/xlayer-testnet.json' with { type: 'json' };
import { fixtureRpc, TEST_ACCOUNT, TEST_NOW } from '../test/testnet-fixture';
import { exchangeAbi, faucetAbi, tokenAbi, vaultAbi, wrapperAbi } from '../src/lib/chain';
import { referenceFixture } from '../test/reference-fixture';

test('test-token page validates amounts and asks the wallet to mint the selected quantity', async ({
  page,
}) => {
  await page.clock.setFixedTime(TEST_NOW);
  await page.route('https://gateway.example.test/**', (route) => route.fulfill({ json: referenceFixture() }));
  await page.route(deployment.rpcUrl, async (route) => {
    const request = route.request().postDataJSON();
    let result;
    if (request.method === 'eth_estimateGas') result = '0x20000';
    if (request.method === 'eth_call') {
      const decoded = decodeFunctionData({
        abi: [...vaultAbi, ...tokenAbi, ...wrapperAbi, ...exchangeAbi, ...faucetAbi],
        data: request.params[0].data,
      });
      if (decoded.functionName === 'symbol')
        result = encodeFunctionResult({
          abi: faucetAbi,
          functionName: 'symbol',
          result: request.params[0].to.toLowerCase() === deployment.stock.toLowerCase() ? 'tNVDAx' : 'tUSDG',
        });
      if (decoded.functionName === 'nextPositionId')
        result = encodeFunctionResult({ abi: vaultAbi, functionName: 'nextPositionId', result: 1n });
    }
    await route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result: result ?? fixtureRpc(request) } });
  });
  await page.addInitScript((account) => {
    (window as any).faucetSends = [];
    (window as any).ethereum = {
      request: async ({ method, params }: any) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
        if (method === 'eth_chainId') return '0x7a0';
        if (method === 'eth_sendTransaction') {
          (window as any).faucetSends.push(params[0]);
          throw { code: 4001 };
        }
        throw new Error(method);
      },
      on() {},
      removeListener() {},
    };
  }, TEST_ACCOUNT);
  await page.goto('/');
  await page.getByRole('link', { name: 'Get test tokens', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Get test tokens.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Test NVIDIA faucet' })).toBeVisible();
  await page.getByRole('button', { name: 'Get test USDG', exact: true }).click();
  await page.getByRole('button', { name: 'Browser wallet', exact: true }).click();
  await page.getByLabel('Amount of tUSDG to receive').fill('1.0000001');
  await page.getByRole('button', { name: 'Get test USDG', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('up to 6 decimal places');
  expect(await page.evaluate(() => (window as any).faucetSends.length)).toBe(0);
  await page.getByLabel('Amount of tUSDG to receive').fill('12345.123456');
  await page.getByRole('button', { name: 'Get test USDG', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(/rejected|cancelled/i);
  const sent = await page.evaluate(() => (window as any).faucetSends[0]);
  expect(sent.to.toLowerCase()).toBe(deployment.usdg.toLowerCase());
  expect(decodeFunctionData({ abi: faucetAbi, data: sent.data }).args).toEqual([12345123456n]);
  await page.getByLabel('Amount of tNVDAx to receive').fill('1.123456789123456789');
  await page.getByRole('button', { name: 'Get test NVIDIA', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Test NVIDIA faucet' }).getByRole('status')).toContainText(
    /rejected|cancelled/i,
  );
  const stockSent = await page.evaluate(() => (window as any).faucetSends[1]);
  expect(stockSent.to.toLowerCase()).toBe(deployment.stockFaucet.toLowerCase());
  expect(decodeFunctionData({ abi: faucetAbi, data: stockSent.data }).args).toEqual([1123456789123456789n]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.getByRole('link', { name: 'Try Sell High' }).click();
  await expect(page.getByRole('heading', { name: 'Sell High order' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Sell High/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('link', { name: 'Get test NVIDIA', exact: true }).click();
  await expect(page).toHaveURL(/\/faucet#stock$/);
});

test('browser fetch reaches gateway directly; an unfunded offer never creates a position', async ({
  page,
}) => {
  const requested: string[] = [];
  await page.clock.setFixedTime(TEST_NOW);
  await page.route('https://gateway.example.test/**', async (route) => {
    requested.push(route.request().url());
    if (route.request().url().endsWith('/v1/reference-quotes'))
      await route.fulfill({ json: referenceFixture() });
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
  await expect(page.getByRole('table', { name: 'Target price and expiry' }).getByRole('button')).toHaveCount(
    6,
  );
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Browser wallet', exact: true }).click();
  await page.getByLabel('Quantity', { exact: true }).fill('0.001');
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Create order' }).getByRole('alert')).toContainText(
    'The dealer cannot fund this quote',
  );
  expect(requested.some((url) => url.endsWith('/v1/rfqs'))).toBe(true);
  await page.getByRole('link', { name: 'Portfolio', exact: true }).click();
  await expect(page.locator('.position-row')).toHaveCount(0);
});

test('static products and public estimates need no RPC or wallet, and quantity/expiry/strategy stay responsive', async ({
  page,
}) => {
  await page.clock.setFixedTime(TEST_NOW);
  let rpcCalls = 0,
    rfqCalls = 0;
  await page.route(deployment.rpcUrl, async (route) => {
    rpcCalls++;
    await route.abort();
  });
  await page.route('https://gateway.example.test/**', async (route) => {
    if (route.request().url().endsWith('/v1/reference-quotes'))
      await route.fulfill({ json: referenceFixture() });
    else {
      rfqCalls++;
      await route.abort();
    }
  });
  await page.goto('/');
  const offers = page.getByRole('table', { name: 'Target price and expiry' });
  await expect(offers.getByRole('button')).toHaveCount(6);
  await page
    .getByRole('group', { name: 'Quantity unit' })
    .getByRole('button', { name: 'wNVDAx', exact: true })
    .click();
  await expect(page.getByTestId('reference-premium')).toHaveText('0.500000 USDG');
  await expect(page.getByTestId('reference-apr')).toHaveText('18.40%');
  await expect(offers.getByRole('button', { pressed: true })).toContainText('18.4% APR');
  await expect(page.getByText(/Last valid market bid/)).toContainText('Sep 18');
  await page.getByLabel('Quantity', { exact: true }).fill('2');
  await expect(page.getByTestId('reference-premium')).toHaveText('1.000000 USDG');
  await offers.locator('tbody tr').first().getByRole('button').nth(1).click();
  await expect(page.getByTestId('reference-premium')).toHaveText('1.000000 USDG');
  await page.getByRole('tab', { name: /Sell High/ }).click();
  await expect(page.getByTestId('reference-premium')).toHaveText('2.500000 USDG');
  await expect(offers.getByRole('button')).toHaveCount(10);
  expect(rpcCalls).toBe(0);
  expect(rfqCalls).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('wallet RPC and reference outages cannot erase the published directory', async ({ page }) => {
  await page.clock.setFixedTime(TEST_NOW);
  await page.route('https://gateway.example.test/**', (route) =>
    route.fulfill({ status: 503, json: { error: { code: 'REFERENCE_UNAVAILABLE' } } }),
  );
  await page.route(deployment.rpcUrl, (route) => route.abort());
  await page.addInitScript((account) => {
    (window as any).ethereum = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') return [account];
        if (method === 'eth_chainId') return '0x7a0';
        throw new Error('No signing in this test');
      },
      on() {},
      removeListener() {},
    };
  }, TEST_ACCOUNT);
  await page.goto('/');
  await expect(page.getByTestId('reference-premium')).toHaveText('Temporarily unavailable');
  const prices = page.getByRole('table', { name: 'Target price and expiry' }).getByRole('button');
  await expect(prices).toHaveCount(6);
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Browser wallet', exact: true }).click();
  await expect(prices).toHaveCount(6);
  await expect(page.getByText('Wallet balances could not be loaded. Refresh to try again.')).toBeVisible();
  await expect(prices).toHaveCount(6);
});

test('public estimates scale with raw wrapped units at a non-unit rate without a wallet', async ({
  page,
}) => {
  await page.clock.setFixedTime(TEST_NOW);
  await page.route(deployment.rpcUrl, (route) => route.abort());
  await page.route('https://gateway.example.test/**', (route) =>
    route.fulfill({ json: referenceFixture(+TEST_NOW, '1003000000000000000') }),
  );
  await page.goto('/');
  await expect(page.getByTestId('wrapping-rate')).toContainText('1 wNVDAx = 1.003 NVDAx');
  await expect(page.getByTestId('reference-premium')).toHaveText('0.498504 USDG');
  await page
    .getByRole('group', { name: 'Quantity unit' })
    .getByRole('button', { name: 'wNVDAx', exact: true })
    .click();
  await expect(page.getByTestId('reference-premium')).toHaveText('0.500000 USDG');
  await expect(page.locator('.order-selection')).toContainText('220.37');
  await expect(page.locator('.offer-table tr:has(button[aria-pressed="true"]) th')).toHaveText('220.37');
  await page.getByRole('tab', { name: /Sell High/ }).click();
  await expect(page.getByTestId('reference-premium')).toHaveText('1.250000 USDG');
  await expect(page.locator('.order-selection')).toContainText('225.38');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
