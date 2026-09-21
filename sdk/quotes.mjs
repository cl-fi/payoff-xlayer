import { hashTypedData } from 'viem';

// Keep field order/types in sync with PayoffTypes.Quote and QuoteLib.TYPEHASH.
export const quoteTypes = {
  Quote: [
    ['requestId', 'bytes32'], ['vault', 'address'], ['dealer', 'address'], ['taker', 'address'],
    ['seriesId', 'uint256'], ['wrappedQuantity', 'uint256'], ['strikeAmountUSDG', 'uint256'],
    ['grossPremiumUSDG', 'uint256'],
    ['protocolFeeUSDG', 'uint256'], ['netPremiumUSDG', 'uint256'],
    ['issuedAt', 'uint64'], ['deadline', 'uint64'], ['nonce', 'uint256'],
  ].map(([name, type]) => ({ name, type })),
};

/** Bigints or decimal strings in base units; never convert token quantities to JS Number. */
export function quoteTypedData(chainId, exchange, quote) {
  const message = Object.fromEntries(quoteTypes.Quote.map(({ name, type }) => {
    if (quote[name] === undefined) throw new Error(`Missing quote field: ${name}`);
    if (type.startsWith('uint') && typeof quote[name] === 'number' && !Number.isSafeInteger(quote[name])) {
      throw new Error(`Unsafe numeric quote field: ${name}`);
    }
    return [name, type.startsWith('uint') ? BigInt(quote[name]) : quote[name]];
  }));
  return {
    domain: { name: 'Payoff RFQ', version: '2', chainId, verifyingContract: exchange },
    primaryType: 'Quote', types: quoteTypes, message,
  };
}

export function quoteDigest(chainId, exchange, quote) {
  return hashTypedData(quoteTypedData(chainId, exchange, quote));
}

/** Pass an existing viem account/wallet; this module never reads environment keys. */
export async function signQuote(signer, chainId, exchange, quote) {
  return signer.signTypedData(quoteTypedData(chainId, exchange, quote));
}
