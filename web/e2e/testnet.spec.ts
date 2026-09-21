import { test, expect, type Page } from '@playwright/test';
import deployment from '../../config/xlayer-testnet.json' with { type: 'json' };
import { fixtureRpc, TEST_ACCOUNT, TEST_NOW } from '../test/testnet-fixture';

async function setup(page: Page, options: { offline?: boolean; wrongChain?: boolean; date?: Date } = {}) {
  await page.clock.setFixedTime(options.date ?? TEST_NOW);
  await page.route(deployment.rpcUrl, async (route) => {
    if (options.offline) {
      await route.fulfill({ status: 503, body: 'Unavailable' });
      return;
    }
    const request = route.request().postDataJSON();
    try {
      await route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result: fixtureRpc(request) } });
    } catch (e) {
      await route.fulfill({
        json: { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: String(e) } },
      });
    }
  });
  await page.addInitScript(
    ({ account, wrongChain }) => {
      const calls: string[] = [];
      const listeners: Record<string, (...args: unknown[]) => void> = {};
      const w = window as unknown as {
        ethereum: unknown;
        walletCalls: string[];
        changeTestAccount: (account: string) => void;
      };
      let current = account;
      w.walletCalls = calls;
      w.changeTestAccount = (next) => {
        current = next;
        listeners.accountsChanged?.([next]);
      };
      w.ethereum = {
        async request({ method }: { method: string }) {
          calls.push(method);
          if (method === 'eth_requestAccounts') return [current];
          if (method === 'eth_chainId') return wrongChain ? '0x1' : '0x7a0';
          throw new Error(`No signing or transactions allowed: ${method}`);
        },
        on(event: string, handler: (...args: unknown[]) => void) {
          listeners[event] = handler;
        },
        removeListener(event: string) {
          delete listeners[event];
        },
      };
    },
    { account: TEST_ACCOUNT, wrongChain: options.wrongChain },
  );
}
async function connect(page: Page) {
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use demo account' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Browser wallet' }).click();
}

test('deployed dates and all strikes, real balances and unavailable quotes', async ({ page }, testInfo) => {
  const errors: string[] = [];
  const quoteRequests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (r.url().includes('/v1/')) quoteRequests.push(r.url());
  });
  await setup(page);
  await page.goto('/');
  await expect(page.getByText('Quotes are not available yet.', { exact: true })).toBeVisible();
  const dates = page.getByRole('group', { name: 'Choose an expiry' });
  const prices = page.getByRole('group', { name: 'Choose a target price' });
  await expect(dates.getByRole('button')).toHaveCount(2);
  await expect(dates).toContainText('Sep 25');
  await expect(dates).toContainText('Oct 2');
  await expect(prices.getByRole('button')).toHaveText(['220.00USDG', '215.00USDG', '210.00USDG']);
  await page.getByText('View settlement terms').click();
  await expect(page.locator('.technical-details')).toContainText('Series #5');
  await expect(page.locator('.technical-details')).toContainText('1 wNVDAx = 1 NVDAx');
  await expect(page.locator('.technical-details')).toContainText('EDT');
  await dates.getByRole('button', { name: /Oct 2/ }).click();
  await prices.getByRole('button', { name: '210.00 USDG' }).click();
  await expect(page.locator('.technical-details')).toContainText('Series #15');
  await page.getByRole('tab', { name: 'Sell High' }).click();
  await expect(prices.getByRole('button')).toHaveText([
    '225.00USDG',
    '230.00USDG',
    '235.00USDG',
    '240.00USDG',
    '245.00USDG',
  ]);
  await prices.getByRole('button', { name: '245.00 USDG' }).click();
  await expect(page.locator('.technical-details')).toContainText('Series #20');
  await connect(page);
  await expect(page.getByRole('button', { name: 'Quotes unavailable', exact: true })).toBeDisabled();
  await expect(page.locator('.available-balance')).toContainText('50.0000 NVDAx');
  await page.screenshot({ path: testInfo.outputPath('testnet-product.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByRole('link', { name: 'My positions', exact: true }).click();
  const assets = page.getByLabel('Testnet wallet balances');
  await expect(assets).toContainText('10.00');
  await expect(assets).toContainText('0.200000');
  await expect(assets).toContainText('50.000000');
  await expect(page.getByText('Position history is not connected yet.', { exact: true })).toBeVisible();
  await expect(page.getByText('Total net premiums')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('testnet-balances.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByRole('link', { name: 'How it works', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Try the demo' })).toHaveCount(0);
  await expect(page.getByText(/tNVDAx and twNVDAx are test tokens, not issuer-backed stocks/)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { walletCalls: string[] }).walletCalls)).toEqual([
    'eth_requestAccounts',
    'eth_chainId',
  ]);
  expect(errors).toEqual([]);
  expect(quoteRequests).toEqual([]);
});

test('RPC failure stays unavailable instead of showing demo data; reload recovers', async ({ page }) => {
  const options = { offline: true };
  await setup(page, options);
  await page.goto('/');
  await expect(page.locator('.global-alert[role=alert]')).toBeVisible();
  await expect(page.locator('.strike-options button')).toHaveCount(0);
  await expect(page.locator('.main-cta')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Demo settings' })).toHaveCount(0);
  options.offline = false;
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(page.locator('.strike-options button')).toHaveCount(3);
  await connect(page);
  await expect(page.locator('.available-balance')).toContainText('10.00 USDG');
  options.offline = true;
  await page.getByRole('button', { name: 'Refresh onchain data' }).click();
  await expect(page.locator('.global-alert[role=alert]')).toBeVisible();
  await expect(page.locator('.available-balance')).toHaveCount(0);
});

test('closed expiries are excluded at the exact cutoff and do not roll forward', async ({ page }) => {
  await setup(page, { date: new Date(1790364600 * 1000) });
  await page.goto('/');
  await expect(page.locator('.tenor-options button')).toHaveCount(1);
  await expect(page.locator('.tenor-options')).toContainText('Oct 2');
  await page.clock.setFixedTime(new Date(1790969400 * 1000));
  await page.reload();
  await expect(page.getByText('No series are open for new positions.')).toBeVisible();
  await expect(page.locator('.main-cta')).toBeDisabled();
  await expect(page.locator('.strike-options button')).toHaveCount(0);
});

test('wrong wallet network is explicit; account changes refresh the queried wallet', async ({ page }) => {
  await setup(page, { wrongChain: true });
  await page.goto('/');
  await connect(page);
  await expect(
    page.getByText('Your wallet is on another network. Data shown here is from X Layer Testnet.'),
  ).toBeVisible();
  await page.getByRole('link', { name: 'My positions', exact: true }).click();
  await expect(page.getByRole('link', { name: 'View wallet on explorer' })).toHaveAttribute(
    'href',
    `${deployment.explorerUrl}/address/${TEST_ACCOUNT}`,
  );
  const next = '0x0000000000000000000000000000000000005678';
  const balanceRead = page.waitForRequest(
    (r) =>
      r.url() === deployment.rpcUrl &&
      r.postData()?.includes('eth_getBalance') === true &&
      r.postData()?.includes(next) === true,
  );
  await page.evaluate(
    (address) => (window as unknown as { changeTestAccount: (a: string) => void }).changeTestAccount(address),
    next,
  );
  await balanceRead;
  await expect(page.getByRole('link', { name: 'View wallet on explorer' })).toHaveAttribute(
    'href',
    `${deployment.explorerUrl}/address/${next}`,
  );
  await expect(page.getByLabel('Testnet wallet balances')).toHaveAttribute('aria-busy', 'false');
});
