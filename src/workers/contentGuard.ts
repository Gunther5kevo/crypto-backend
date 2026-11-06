/**
 * contentGuard.ts — drop-in checks for aiWorker.ts
 * Purpose: stop thin, templated, off-topic, or leaked-prompt posts from ever
 * being published, and make a human approve anything that goes live.
 */

// ─────────────────────────────────────────────────────────────
// 1. COIN DETECTION (replaces detectCoins; fixes substring matches)
// "op" no longer matches "stop", "ton" no longer matches "Washington", etc.
// ─────────────────────────────────────────────────────────────
// Names/tickers that are also common English words or fragments. These only
// count when written as a ticker: ALL CAPS ("LINK", "OP") or "$LINK".
const AMBIGUOUS = new Set([
  'link', 'near', 'op', 'dot', 'ton', 'uni', 'sol', 'ada', 'arb', 'sui', 'apt',
  'inj', 'fet', 'fetch', 'render', 'maker', 'aave', 'matic', 'shiba', 'pepe',
]);

export function detectCoinsSafe(text: string, coinMap: Record<string, string>): string[] {
  const found = new Set<string>();
  for (const [key, coinId] of Object.entries(coinMap)) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (AMBIGUOUS.has(key)) {
      // ticker form only: $LINK or standalone uppercase LINK
      const re = new RegExp(`(?:\\$${esc.toUpperCase()}\\b|(?<![A-Za-z])${esc.toUpperCase()}(?![A-Za-z]))`);
      if (re.test(text)) found.add(coinId);
    } else {
      // unambiguous names/tickers: whole word, any case
      if (new RegExp(`(?<![A-Za-z])${esc}(?![A-Za-z])`, 'i').test(text)) found.add(coinId);
    }
  }
  return [...found].slice(0, 5);
}

// ─────────────────────────────────────────────────────────────
// 2. SOURCE SUBSTANCE (call right after shouldBlog)
// An 800-word article needs real facts to be built from. Short or
// fact-free sources go to Telegram quick-update only, not the blog.
// ─────────────────────────────────────────────────────────────
export function hasEnoughSubstance(text: string): { ok: boolean; reason: string } {
  const cleaned = text.replace(/https?:\/\/\S+/g, ' ').replace(/#\w+/g, ' ');
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 20) return { ok: false, reason: `source too short (${words.length} words)` };

  const numbers = (cleaned.match(/\$?\d[\d,.]*\s?(%|[bmk]\b|million|billion)?/gi) || []).length;
  // capitalised words that are not the first word of a sentence ≈ named entities
  const entities = new Set(
    (cleaned.match(/(?<=[a-z,;:]\s)[A-Z][a-zA-Z]{2,}/g) || []).map(s => s.toLowerCase()),
  );
  const facts = numbers + entities.size;
  if (facts < 4) return { ok: false, reason: `too few concrete facts (${facts})` };

  const priceOnly = /(price|trading at|slips|rises|falls|drops)/i.test(cleaned)
    && !/(because|after|following|announced|filed|approved|hack|launch|ruling|court|sec|law|bill|report)/i.test(cleaned);
  if (priceOnly) return { ok: false, reason: 'price movement with no cause or event' };

  return { ok: true, reason: 'ok' };
}

// ─────────────────────────────────────────────────────────────
// 3. LEAKED META-TEXT + PADDING CHECKS (run on the finished post)
// ─────────────────────────────────────────────────────────────
const META_LEAK = [
  /focus (key ?word|keyphrase)/i, /\bkeyword appears\b/i, /\bclean update\b/i,
  /\bmeta (title|description)\b/i, /\bseo\b/i, /\bas an ai\b/i,
  /\bword count\b/i,
  /\bthe (keyword|excerpt) (is|should)\b/i,
];

export function findMetaLeaks(post: {
  title?: string; excerpt?: string; meta_title?: string;
  meta_description?: string; content?: string;
}): string[] {
  const hits: string[] = [];
  for (const [field, val] of Object.entries(post)) {
    if (typeof val !== 'string') continue;
    for (const re of META_LEAK) {
      const m = val.match(re);
      if (m) hits.push(`${field}: "${m[0]}"`);
    }
  }
  return hits;
}

/** Same figure repeated 4+ times = padding. Returns offenders. */
export function findRepeatedFigures(plain: string): string[] {
  const counts = new Map<string, number>();
  for (const n of plain.match(/\$?\d[\d,]*\.?\d*\s?[%BMK]?/g) || []) {
    if (n.trim().length >= 4) counts.set(n.trim(), (counts.get(n.trim()) ?? 0) + 1);
  }
  return [...counts].filter(([, c]) => c >= 4).map(([n, c]) => `${n} x${c}`);
}

/** Filler "analysis" phrases the jargon list doesn't catch. */
const PADDING_PHRASES = [
  'tells a simple story', 'tug of war', 'patience, not conviction', 'reacts more than it leads',
  'buyers are still active', 'sellers keep meeting', 'busy, but unsure', 'wait for proof',
  'keeps the long view', 'hope and caution meet', 'the numbers give a clear read',
  'the headline is', 'this article explains', 'this piece explains', 'in this article, we',
];
export function findPadding(plain: string): string[] {
  const l = plain.toLowerCase();
  return PADDING_PHRASES.filter(p => l.includes(p));
}

// ─────────────────────────────────────────────────────────────
// 4. TEMPLATE REPEAT (replaces the 24h keyword-overlap dedupe for titles)
// "LINK price slips to $11.11…" vs "$11.33…" normalise to the same string.
// ─────────────────────────────────────────────────────────────
const norm = (s: string) =>
  s.toLowerCase().replace(/[\d$.,%]+[bmk]?/g, '#').replace(/[^a-z#\s]/g, ' ').replace(/\s+/g, ' ').trim();

export function isTemplateRepeat(newTitle: string, recentTitles: string[]): string | null {
  const a = norm(newTitle);
  const aw = new Set(a.split(' '));
  for (const t of recentTitles) {
    const b = norm(t);
    if (a === b) return t;
    const bw = new Set(b.split(' '));
    let inter = 0;
    aw.forEach(w => bw.has(w) && inter++);
    if (inter / (aw.size + bw.size - inter) > 0.7) return t;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 4b. CRYPTO-ONLY GATE
// Used twice: on the SOURCE message (before spending any AI tokens) and on the
// FINISHED ARTICLE (so an off-topic story can never be published even if the
// model drifts). Counts DISTINCT crypto terms, whole-word, so one stray mention
// ("...could shake crypto pricing") is not enough to pass.
// ─────────────────────────────────────────────────────────────
const CRYPTO_TERMS = [
  'bitcoin', 'btc', 'ethereum', 'ether', 'crypto', 'cryptocurrency', 'cryptocurrencies',
  'blockchain', 'token', 'tokens', 'altcoin', 'altcoins', 'defi', 'nft', 'nfts',
  'stablecoin', 'stablecoins', 'usdt', 'usdc', 'web3', 'dex', 'staking', 'airdrop',
  'halving', 'satoshi', 'binance', 'coinbase', 'kraken', 'bybit', 'okx', 'solana',
  'xrp', 'ripple', 'dogecoin', 'memecoin', 'memecoins', 'smart contract', 'on-chain',
  'onchain', 'layer 2', 'layer-2', 'rollup', 'validator', 'private key', 'seed phrase',
  'hardware wallet', 'crypto wallet', 'cold wallet', 'defi protocol', 'market cap',
  'spot etf', 'bitcoin etf', 'ethereum etf', 'mining rig', 'hashrate', 'proof of stake',
  'proof-of-work', 'proof-of-stake', 'liquidity pool', 'tvl',
  'eth', 'digital asset', 'digital assets', 'cardano', 'chainlink', 'avalanche', 'polkadot',
  'uniswap', 'arbitrum', 'litecoin', 'bnb', 'crypto market', 'crypto exchange',
  'bitcoin treasury', 'clarity act', 'genius act',
];

export function isCryptoContent(
  text: string,
  detectedCoinCount = 0,
  minDistinct = 2,
): { ok: boolean; reason: string; hits: string[] } {
  const hits = CRYPTO_TERMS.filter(t => {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![A-Za-z])${esc}(?![A-Za-z])`, 'i').test(text);
  });
  // A real ticker/coin match (word-boundary safe) counts as one extra signal
  const signals = hits.length + (detectedCoinCount > 0 ? 1 : 0);
  if (signals >= minDistinct && hits.length >= 1) {
    return { ok: true, reason: 'ok', hits };
  }
  return {
    ok: false,
    reason: `not clearly about crypto (${hits.length} crypto terms, ${detectedCoinCount} coins; need ${minDistinct})`,
    hits,
  };
}

// ─────────────────────────────────────────────────────────────
// 5. PUBLISH DECISION (replaces shouldPublish)
// Default: NOTHING auto-publishes. A person reviews drafts, adds their own
// analysis, and publishes. Set AUTO_PUBLISH=true only after the site is
// approved and you have verified the output quality yourself.
// ─────────────────────────────────────────────────────────────
export function decide(opts: {
  score: number; metaLeaks: string[]; repeatedFigures: string[];
  padding: string[]; templateRepeatOf: string | null;
  notCrypto?: string | null; tooThin?: string | null;
  threshold?: number; // auto-publish score; default 85
}): { action: 'draft' | 'reject' | 'publish'; reasons: string[] } {
  const reasons: string[] = [];
  if (opts.notCrypto) reasons.push(`off-topic: ${opts.notCrypto}`);
  if (opts.tooThin) reasons.push(`too thin: ${opts.tooThin}`);
  if (opts.metaLeaks.length) reasons.push(`leaked meta text: ${opts.metaLeaks.join('; ')}`);
  if (opts.templateRepeatOf) reasons.push(`repeats recent post: "${opts.templateRepeatOf}"`);
  if (opts.repeatedFigures.length) reasons.push(`padding, repeated figures: ${opts.repeatedFigures.join(', ')}`);
  if (opts.padding.length) reasons.push(`filler phrases: ${opts.padding.join(', ')}`);

  if (opts.notCrypto || opts.tooThin || opts.metaLeaks.length || opts.templateRepeatOf)
    return { action: 'reject', reasons };
  if (reasons.length) return { action: 'draft', reasons };

  const auto = process.env.AUTO_PUBLISH === 'true' && opts.score >= (opts.threshold ?? 85);
  return { action: auto ? 'publish' : 'draft', reasons: auto ? [] : ['awaiting human review'] };
}