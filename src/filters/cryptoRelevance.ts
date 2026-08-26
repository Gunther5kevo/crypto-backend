// ─────────────────────────────────────────────────────────────
// CRYPTO RELEVANCE FILTER
//
// Shared gate used at ingestion (bot webhook) and before any
// Telegram output (aiEnrichWorker quick-update alerts). This site
// only deals in crypto content, so anything that doesn't look like
// crypto — a contact DMing the bot small talk, off-topic chatter in
// a monitored channel — must never reach the Telegram channel or
// the ingest queue, even when no blog post is generated from it.
//
// Coin names are matched in full ("solana", "cardano") rather than
// short tickers ("sol", "ada") because those short forms collide
// with common English words and would defeat the point of a spam
// filter. Short tickers are still caught via TICKER_PATTERN ($SOL).
// ─────────────────────────────────────────────────────────────
const CRYPTO_TERMS = [
  'crypto', 'cryptocurrency', 'bitcoin', 'btc', 'ethereum', 'eth',
  'blockchain', 'altcoin', 'altcoins', 'token', 'tokens', 'defi',
  'nft', 'nfts', 'web3', 'dao', 'wallet', 'airdrop', 'whitelist',
  'presale', 'ico', 'ido', 'tokenomics',
  'binance', 'coinbase', 'kraken', 'bybit', 'okx', 'metamask', 'ledger',
  'solana', 'xrp', 'ripple', 'cardano', 'avalanche', 'avax', 'polkadot',
  'chainlink', 'polygon', 'matic', 'dogecoin', 'doge', 'shiba', 'shib',
  'pepe', 'floki', 'arbitrum', 'optimism', 'aptos', 'injective',
  'uniswap', 'aave', 'maker', 'stablecoin', 'usdt', 'usdc', 'tether',
  'hodl', 'wagmi', 'ngmi', 'fud', 'fomo', 'rekt',
  'bull market', 'bear market', 'market cap', 'take profit', 'stop loss',
  'leverage', 'futures', 'entry price', 'sec charges', 'etf approved',
  'etf rejected', 'halving', 'rug pull', 'staking', 'mining', 'satoshi',
  'gwei', 'delisted', 'depegged',
];

const TICKER_PATTERN = /\$[A-Z]{2,6}\b/;
const PRICE_MOVE_PATTERN = /[▲▼]\s*[\d.]+%/;

function matchesTerm(lower: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(lower);
}

export function isCryptoRelevant(text: string): boolean {
  if (!text?.trim()) return false;
  const lower = text.toLowerCase();
  if (CRYPTO_TERMS.some(term => matchesTerm(lower, term))) return true;
  if (TICKER_PATTERN.test(text)) return true;
  if (PRICE_MOVE_PATTERN.test(text)) return true;
  return false;
}
