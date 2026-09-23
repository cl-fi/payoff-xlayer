import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backingDonation } from '../../scripts/align-testnet-wrapper.mjs';
test('test-only backing alignment includes ERC4626 virtual units and is idempotent', () => {
  const supply = 153002200000000000000n, rate = 1001701196801074000n, WAD = 10n ** 18n;
  const donation = backingDonation(rate, supply, supply);
  assert(donation > 0n);
  assert.equal(WAD * (supply + donation + 1n) / (supply + 1n), rate);
  assert.equal(backingDonation(rate, supply + donation, supply), 0n);
  assert.throws(() => backingDonation(WAD, supply + donation, supply), /lower/);
  assert.throws(() => backingDonation(rate, 0n, 0n), /empty/);
  assert.throws(() => backingDonation(rate, 1n, 1n), /representable/);
});
