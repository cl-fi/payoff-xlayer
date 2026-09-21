import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { hashStruct } from 'viem';
import { quoteTypes, quoteTypedData, quoteDigest, signQuote } from '../sdk/quotes.mjs';

// PUBLIC TEST KEY, never fund it. Only generates an offline interoperability fixture.
const account = privateKeyToAccount('0x' + '1'.padStart(64, '0'));
const exchange = '0x1111111111111111111111111111111111111111';
const quote = {
  requestId: '0x' + 'ab'.repeat(32), vault: '0x2222222222222222222222222222222222222222',
  dealer: account.address, taker: '0x3333333333333333333333333333333333333333',
  seriesId: 7n, wrappedQuantity: 123456789012345678n, strikeAmountUSDG: 24691358n,
  grossPremiumUSDG: 2000000n,
  protocolFeeUSDG: 20000n, netPremiumUSDG: 1980000n,
  issuedAt: 1800000000n, deadline: 1800000020n, nonce: 9007199254740993n,
};
const vector = {
  chainId: 196, exchange, quote,
  structHash: hashStruct({ data: quote, primaryType: 'Quote', types: quoteTypes }),
  digest: quoteDigest(196, exchange, quote), signature: await signQuote(account, 196, exchange, quote),
};
const serialized = JSON.stringify(vector, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
const path = new URL('../test/fixtures/quote-vector.json', import.meta.url);
if (process.argv.includes('--write')) await writeFile(path, serialized);
else assert.equal(await readFile(path, 'utf8'), serialized, 'SDK/schema drifted from the committed vector');
assert.throws(() => quoteTypedData(196, exchange, { ...quote, wrappedQuantity: 1e18 }), /Unsafe numeric/);
assert.notEqual(quoteDigest(197, exchange, quote), vector.digest);
assert.notEqual(quoteDigest(196, quote.vault, quote), vector.digest);
assert.notEqual(quoteDigest(196, exchange, { ...quote, vault: exchange }), vector.digest);
console.log('Quote SDK: deterministic EIP-712 vector and domain/Vault separation passed.');
