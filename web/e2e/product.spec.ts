import { test, expect, type Page } from '@playwright/test';
import { routeCandles } from './hyperliquid';
async function connect(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect to get started' }).click();
  await page.getByRole('button', { name: 'Use demo account' }).click();
}
async function quote(page: Page, side: 'Buy Low' | 'Sell High' = 'Buy Low') {
  if (side === 'Sell High') await page.getByRole('tab', { name: 'Sell High' }).click();
  await page.getByRole('button', { name: 'Prepare assets', exact: true }).click();
  await page.getByRole('button', { name: 'Simulate asset preparation', exact: true }).click();
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirm your quote' })).toBeVisible();
}
async function fill(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Demo position created. ')).toBeVisible();
  await page.getByRole('link', { name: 'View portfolio' }).click();
}
async function scenario(page: Page, name: string) {
  await page.getByRole('button', { name: 'Demo settings' }).click();
  await page.getByRole('radio', { name }).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
}
for (const side of ['Buy Low', 'Sell High'] as const)
  for (const outcome of ['Simulate dealer exercise', 'Simulate expiry without exercise']) {
    test(`${side}: full fill → ${outcome} → claim → reload`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await connect(page);
      await quote(page, side);
      await fill(page);
      await page.getByRole('button', { name: new RegExp(`NVDAx · ${side} Demo position`) }).click();
      await page.getByText('Simulate an outcome', { exact: true }).click();
      await page.getByRole('button', { name: outcome, exact: true }).click();
      await page.getByRole('button', { name: 'Claim demo assets' }).click();
      await expect(page.getByText('Assets claimed. The premium remains yours.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Claim demo assets' })).toHaveCount(0);
      await page.reload();
      await expect(page.locator('.position-row')).toHaveCount(1);
      await expect(page.locator('.position-row')).toContainText('Claimed');
      expect(errors).toEqual([]);
    });
  }
test.beforeEach(({ page }) => routeCandles(page));

test('no quote, expired and cancelled confirmations never create a position', async ({ page }) => {
  await connect(page);
  await scenario(page, 'No quotes');
  await page.getByRole('button', { name: 'Prepare assets', exact: true }).click();
  await page.getByRole('button', { name: 'Simulate asset preparation', exact: true }).click();
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Create order' }).getByRole('alert')).toContainText(
    'No quotes are available right now',
  );
  await scenario(page, 'Expired quote');
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(page.getByText('Quote expired', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await scenario(page, 'Cancel confirmation');
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Simulated cancellation');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('link', { name: 'Portfolio', exact: true }).click();
  await expect(page.locator('.position-row')).toHaveCount(0);
});
test('quote countdown really expires and changed quantity invalidates previous quote', async ({ page }) => {
  await page.clock.install();
  await connect(page);
  await quote(page);
  await page.clock.fastForward(91000);
  await expect(page.getByText('Quote expired', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  // More than the 1000 USDG prepared for the expired quote needs a new approval.
  await page.getByLabel('You deposit', { exact: true }).fill('2000');
  await expect(page.getByRole('button', { name: 'Prepare assets', exact: true })).toBeVisible();
  await page.getByLabel('You deposit', { exact: true }).fill('0');
  await expect(page.locator('#quantity-error')).toBeVisible();
  await expect(page.locator('.main-cta')).toBeDisabled();
});
test('real injected wallet in demo is never asked to sign or send; account changes clear quote', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as { ethereum: unknown; walletCalls: string[]; emitAccount: () => void };
    const handlers = new Map<string, (...args: unknown[]) => void>();
    w.walletCalls = [];
    w.ethereum = {
      request: async ({ method }: { method: string }) => {
        w.walletCalls.push(method);
        if (method === 'eth_chainId') return '0x7a0';
        if (method === 'eth_requestAccounts' || method === 'eth_accounts')
          return ['0x0000000000000000000000000000000000000001'];
        throw new Error('Unexpected wallet call: ' + method);
      },
      on: (event: string, fn: (...args: unknown[]) => void) => handlers.set(event, fn),
      removeListener: (event: string) => handlers.delete(event),
    };
    w.emitAccount = () => handlers.get('accountsChanged')?.(['0x0000000000000000000000000000000000000002']);
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Browser wallet', exact: true }).click();
  await quote(page);
  await fill(page);
  expect(await page.evaluate(() => (window as unknown as { walletCalls: string[] }).walletCalls)).toEqual([
    'eth_requestAccounts',
    'eth_chainId',
  ]);
  await page.getByRole('link', { name: 'Dual Investment', exact: true }).click();
  await quote(page);
  await page.evaluate(() => (window as unknown as { emitAccount: () => void }).emitAccount());
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link', { name: 'Portfolio', exact: true }).click();
  await expect(page.locator('.position-row')).toHaveCount(0);
});
test('all routes fit viewport, keyboard dialog closes and screenshots render', async ({ page }, info) => {
  for (const path of ['/', '/positions', '/how-it-works']) {
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({
      path: `test-results/${info.project.name}-${path === '/' ? 'product' : path.slice(1)}.png`,
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('selecting the 14-day series uses its actual terms and premium', async ({ page }) => {
  await connect(page);
  await page.getByRole('button', { name: /14 days/ }).click();
  await expect(page.locator('.order-selection')).toHaveText('175.00 USDG · 14 days');
  await page.getByRole('group', { name: 'Deposit unit' }).getByRole('button', { name: 'NVDAx' }).click();
  await page.getByLabel('You deposit', { exact: true }).fill('1');
  await quote(page);
  await expect(page.getByRole('dialog').locator('.premium-display strong')).toContainText('2.42');
});

test('Buy Low takes a USDG amount, never locks more than typed, and fills from the balance', async ({
  page,
}) => {
  await connect(page);
  const order = page.getByRole('region', { name: 'Create order' });
  const deposit = page.getByLabel('You deposit', { exact: true });
  const unit = page.getByRole('group', { name: 'Deposit unit' });
  await expect(deposit).toHaveValue('1000');
  await expect(unit.getByRole('button', { name: 'USDG' })).toHaveAttribute('aria-pressed', 'true');
  await expect(order.locator('#quantity-conversion')).toContainText(/≈ [\d.]+ NVDAx if bought at 175\.00/);
  // Switching units re-expresses the order; switching back before editing restores the typed amount.
  await unit.getByRole('button', { name: 'NVDAx' }).click();
  await expect(deposit).toHaveValue(/^5\.71\d+$/);
  await expect(order.locator('#quantity-conversion')).toContainText('Locks 999.99 USDG at 175.00');
  await unit.getByRole('button', { name: 'USDG' }).click();
  await expect(deposit).toHaveValue('1000');
  // Over the balance: the order cannot proceed, and Max fixes it in one click.
  await deposit.fill('12000');
  await expect(order.locator('#quantity-error')).toContainText('Exceeds your 10,000.00 USDG balance.');
  await expect(page.locator('.main-cta')).toHaveText(/Insufficient USDG/);
  await expect(page.locator('.main-cta')).toBeDisabled();
  await order.locator('#quantity-error').getByRole('button', { name: 'Use max' }).click();
  await expect(deposit).toHaveValue('10000');
  await order
    .getByRole('group', { name: 'Use part of your balance' })
    .getByRole('button', { name: '25%' })
    .click();
  await expect(deposit).toHaveValue('2500');
  await quote(page);
  const settlement = await page
    .getByRole('dialog')
    .locator('.receipt-list > div', { hasText: 'Settlement amount' })
    .locator('strong')
    .textContent();
  expect(Number(settlement!.replace(/[^\d.]/g, ''))).toBeLessThanOrEqual(2500);
  await fill(page);
  await expect(page.locator('.position-row')).toHaveCount(1);
});

test('Sell High deposits NVDAx; Max uses the whole NVDAx balance', async ({ page }) => {
  await connect(page);
  await page.getByRole('tab', { name: 'Sell High' }).click();
  const deposit = page.getByLabel('You deposit', { exact: true });
  await expect(deposit).toHaveValue('1');
  await expect(page.getByRole('group', { name: 'Deposit unit' })).toHaveCount(0);
  await expect(page.locator('#quantity-conversion')).toContainText('≈ 185.00 USDG if sold at 185.00');
  await page
    .getByRole('group', { name: 'Use part of your balance' })
    .getByRole('button', { name: 'Max' })
    .click();
  await expect(deposit).toHaveValue('8');
  await deposit.fill('9');
  await expect(page.locator('#quantity-error')).toContainText('Exceeds your 8.0000 NVDAx balance.');
  // Each side keeps its own deposit.
  await page.getByRole('tab', { name: 'Buy Low' }).click();
  await expect(deposit).toHaveValue('1000');
});

test('changing units discards a pending quote', async ({ page }) => {
  await connect(page);
  await page.getByRole('button', { name: 'Prepare assets', exact: true }).click();
  await page.getByRole('button', { name: 'Simulate asset preparation', exact: true }).click();
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await page.getByRole('group', { name: 'Deposit unit' }).getByRole('button', { name: 'NVDAx' }).click();
  await page.clock.runFor(2000);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('You deposit', { exact: true })).not.toHaveValue('1000');
  await expect(page.getByRole('button', { name: 'Get a quote', exact: true })).toBeEnabled();
});
