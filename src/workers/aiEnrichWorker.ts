import { Worker, Job } from 'bullmq';
import OpenAI from 'openai';
import { redisConnection, storeQueue, draftQueue } from '../queue/queues';
import { NormalizedMessage } from '../types/message';
import { Post, ReferralLink } from '../supabase/client';
import { supabase } from '../supabase/client';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─────────────────────────────────────────────────────────────
// SECTION 1 — BLOG-WORTHINESS FILTER
// ─────────────────────────────────────────────────────────────
function shouldBlog(text: string): boolean {
  const lower = text.toLowerCase().trim();
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  if (wordCount < 10) return false;

  const priceTicker = /^[a-z\s/]+:\s*\$[\d,]+(\.\d+)?\s*[▲▼]?\s*[\d.]+%\s*$/i;
  if (priceTicker.test(lower)) return false;

  const lines = text.split('\n').filter(l => l.trim());
  const priceLines = lines.filter(l => /\$[\d,]+(\.\d+)?/.test(l));
  if (lines.length > 3 && priceLines.length / lines.length > 0.7) return false;

  const junkPatterns = [
    /^\d[\d\s.,]+$/,
    /^(gm|gn|lfg|wagmi|ngmi|hodl)[\s!.]*$/i,
    /^(wen\s+moon|to\s+the\s+moon)[\s!.]*$/i,
  ];
  if (junkPatterns.some(p => p.test(lower))) return false;

  return true;
}

// ─────────────────────────────────────────────────────────────
// SECTION 2 — DEDUPLICATION
// ─────────────────────────────────────────────────────────────
async function isDuplicate(text: string, title: string): Promise<boolean> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: recentPosts, error } = await supabase
      .from('posts')
      .select('title, excerpt')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error || !recentPosts?.length) return false;

    const stopWords = new Set([
      'the','a','an','and','or','but','in','on','at','to','for','of','with',
      'is','are','was','were','be','been','has','have','had','will','would',
      'that','this','it','as','by','from','its','their','they','about','after',
      'bitcoin','crypto','blockchain',
    ]);

    const keywords = (text + ' ' + title)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w));

    if (!keywords.length) return false;

    for (const post of recentPosts) {
      const existing = `${post.title} ${post.excerpt}`.toLowerCase();
      const matchCount = keywords.filter(kw => existing.includes(kw)).length;
      const overlap = matchCount / keywords.length;

      if (overlap > 0.6) {
        console.log(`[aiWorker] 🔁 Duplicate detected (${Math.round(overlap * 100)}% overlap) with: "${post.title}"`);
        return true;
      }
    }

    return false;
  } catch (err) {
    console.warn('[aiWorker] ⚠️ Dedup check failed, allowing post:', err);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// SECTION 3 — CATEGORY CLASSIFIER
// ─────────────────────────────────────────────────────────────
function classifyCategory(text: string): string {
  const lower = text.toLowerCase();

  if (
    lower.includes('airdrop') ||
    lower.includes('claim now') ||
    lower.includes('free token') ||
    lower.includes('whitelist')
  ) return 'airdrop';

  const signalTerms = [
    'entry', 'take profit', 'stop loss', 'tp:', 'sl:', 'long ', 'short ',
    'leverage', 'futures', 'target:', 'invalidation', 'risk/reward',
  ];
  if (signalTerms.filter(t => lower.includes(t)).length >= 2) return 'signal';

  const guideTerms = [
    'how to', 'step by step', 'guide', 'tutorial', 'beginners', 'explained',
    'what is', 'learn', 'introduction to', 'understanding',
  ];
  if (guideTerms.some(t => lower.includes(t))) return 'guide';

  return 'news';
}

// ─────────────────────────────────────────────────────────────
// SECTION 3b — AFRICAN CONTEXT DETECTOR
// Only inject African/Kenyan framing when the story is
// genuinely relevant to that market — not on every article.
// ─────────────────────────────────────────────────────────────
const AFRICA_RELEVANT_TERMS = [
  // Geography
  'africa', 'african', 'kenya', 'kenyan', 'nigeria', 'nigerian', 'ghana', 'ghanaian',
  'south africa', 'ethiopia', 'tanzania', 'uganda', 'rwanda', 'egypt',
  'nairobi', 'lagos', 'accra', 'johannesburg', 'cairo',
  // Finance / infra that maps to African context
  'm-pesa', 'mpesa', 'mobile money', 'remittance', 'unbanked',
  'local exchange', 'binance p2p', 'yellow card', 'bitpesa', 'paxful',
  // Macro signals that genuinely affect African investors
  'dollar shortage', 'currency devaluation', 'forex', 'capital controls',
  'emerging market', 'imf', 'world bank',
];

/**
 * Returns true only when the source text contains terms that make
 * African / Kenyan market framing genuinely relevant.
 */
function isAfricanContextRelevant(text: string): boolean {
  const lower = text.toLowerCase();
  return AFRICA_RELEVANT_TERMS.some(term => lower.includes(term));
}

// ─────────────────────────────────────────────────────────────
// SECTION 4 — SLUG GENERATOR
// ─────────────────────────────────────────────────────────────
const SLUG_FILLER = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with',
  'is','are','was','were','be','been','has','have','had','will','would',
  'that','this','it','as','by','from','its','their','they','about',
  'comprehensive','deep','dive','delve','unlock','empower','game','changer',
  'groundbreaking','revolutionary','transformative','pioneering','cutting','edge',
  'holistic','robust','synergy','ecosystem','landscape','journey','navigate',
  'exciting','crucial','vital','key','important','significant','major',
]);

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 0 && !SLUG_FILLER.has(w))
    .join('-')
    .replace(/-+/g, '-')
    .trim()
    .slice(0, 80);
}

// ─────────────────────────────────────────────────────────────
// SECTION 5 — REFERRAL LINKS
// ─────────────────────────────────────────────────────────────
function buildReferralLinks(urls: string[]): ReferralLink[] {
  return urls.map(url => {
    let type: ReferralLink['type'] = 'external';
    if (url.includes('airdrop') || url.includes('claim')) type = 'airdrop';
    else if (url.includes('ref=') || url.includes('referral')) type = 'referral';
    return { url, type };
  });
}

// ─────────────────────────────────────────────────────────────
// SECTION 6 — TAG BUILDER
// ─────────────────────────────────────────────────────────────
const BANNED_TAGS = new Set([
  'sentiment', 'sentiments', 'analysis', 'landscape', 'ecosystem',
  'navigate', 'journey', 'unlock', 'delve', 'dive',
]);

function sanitiseTags(tags: string[]): string[] {
  return tags
    .map(t => t.toLowerCase().trim().replace(/\s+/g, '-'))
    .filter(t => t.length > 0 && !BANNED_TAGS.has(t));
}

function buildTags(
  aiTags: string[] | undefined,
  hashtags: string[],
  category: string,
): string[] {
  const sanitised = sanitiseTags(aiTags ?? []);
  if (sanitised.length >= 5) return sanitised.slice(0, 7);

  const fromHashtags = sanitiseTags(hashtags);
  if (fromHashtags.length >= 3) return fromHashtags.slice(0, 7);

  return [category, 'crypto', 'blockchain', 'defi', 'web3'];
}

// ─────────────────────────────────────────────────────────────
// SECTION 7 — LIVE MARKET DATA (CoinGecko)
// ─────────────────────────────────────────────────────────────
interface CoinData {
  symbol: string;
  price: number;
  change24h: number;
  change7d: number;
  marketCap: number;
  volume24h: number;
  ath: number;
  athChangePercent: number;
}

const COIN_MAP: Record<string, string> = {
  bitcoin: 'bitcoin', btc: 'bitcoin',
  ethereum: 'ethereum', eth: 'ethereum',
  solana: 'solana', sol: 'solana',
  bnb: 'binancecoin', 'binance coin': 'binancecoin',
  xrp: 'ripple', ripple: 'ripple',
  cardano: 'cardano', ada: 'cardano',
  avalanche: 'avalanche-2', avax: 'avalanche-2',
  polkadot: 'polkadot', dot: 'polkadot',
  chainlink: 'chainlink', link: 'chainlink',
  polygon: 'matic-network', matic: 'matic-network',
  dogecoin: 'dogecoin', doge: 'dogecoin',
  shiba: 'shiba-inu', shib: 'shiba-inu',
  pepe: 'pepe', floki: 'floki',
  arbitrum: 'arbitrum', arb: 'arbitrum',
  optimism: 'optimism', op: 'optimism',
  sui: 'sui', aptos: 'aptos', apt: 'aptos',
  ton: 'the-open-network',
  near: 'near',
  injective: 'injective-protocol', inj: 'injective-protocol',
  fetch: 'fetch-ai', fet: 'fetch-ai',
  render: 'render-token', rndr: 'render-token',
  uniswap: 'uniswap', uni: 'uniswap',
  aave: 'aave',
  maker: 'maker', mkr: 'maker',
};

function detectCoins(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const [keyword, coinId] of Object.entries(COIN_MAP)) {
    if (lower.includes(keyword)) found.add(coinId);
  }
  return [...found].slice(0, 5);
}

async function fetchCoinData(coinIds: string[]): Promise<CoinData[]> {
  if (!coinIds.length) return [];

  try {
    const ids = coinIds.join(',');
    const url =
      `https://api.coingecko.com/api/v3/coins/markets` +
      `?vs_currency=usd&ids=${ids}&order=market_cap_desc` +
      `&sparkline=false&price_change_percentage=24h,7d`;

    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);

    const data = await res.json();
    return data.map((c: any) => ({
      symbol:           c.symbol.toUpperCase(),
      price:            c.current_price,
      change24h:        c.price_change_percentage_24h ?? 0,
      change7d:         c.price_change_percentage_7d_in_currency ?? 0,
      marketCap:        c.market_cap,
      volume24h:        c.total_volume,
      ath:              c.ath,
      athChangePercent: c.ath_change_percentage ?? 0,
    }));
  } catch (err) {
    console.warn('[aiWorker] ⚠️ CoinGecko fetch failed:', err);
    return [];
  }
}

function formatCoinContext(coins: CoinData[]): string {
  if (!coins.length) return 'No specific coin price data is relevant to this story.';
  return coins
    .map(c => {
      const dir24  = c.change24h >= 0 ? '▲' : '▼';
      const dir7d  = c.change7d  >= 0 ? '▲' : '▼';
      const price  = c.price < 1
        ? `$${c.price.toFixed(6)}`
        : `$${c.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
      const mcap   = `$${(c.marketCap / 1e9).toFixed(2)}B`;
      const vol    = `$${(c.volume24h / 1e6).toFixed(1)}M`;
      const athOff = `${Math.abs(c.athChangePercent).toFixed(1)}% below ATH`;
      return (
        `${c.symbol}: ${price} | 24h: ${dir24}${Math.abs(c.change24h).toFixed(2)}%` +
        ` | 7d: ${dir7d}${Math.abs(c.change7d).toFixed(2)}%` +
        ` | MCap: ${mcap} | Vol: ${vol} | ${athOff}`
      );
    })
    .join('\n');
}

// ─────────────────────────────────────────────────────────────
// SECTION 7b — TELEGRAM QUICK UPDATE FORMATTER
// Clean, professional format — no emoji, no source attribution.
// ─────────────────────────────────────────────────────────────

/**
 * Extracts the most important sentence from a short update — the one
 * with a number, ticker, or named entity in it.
 */
function extractHeadline(text: string): string {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 20);

  // Prefer sentences that contain a price, percentage, or coin name
  const hot = sentences.find(s => /\$[\d,]|[\d.]+%|btc|eth|sol|xrp|bnb/i.test(s));
  return (hot || sentences[0] || text).slice(0, 160);
}

/**
 * Formats a clean, professional Telegram quick-update message.
 * Structure: bold headline → clean body → @cryptomoney handle
 */
function formatTelegramQuickUpdate(text: string, _author: string): string {
  // Strip any @handle mentions so source channel names don't bleed through
  const stripped = text.replace(/@\w+/g, '').replace(/\n{3,}/g, '\n\n').trim();

  const headline = extractHeadline(stripped);

  // Clean body: strip markdown syntax that breaks Telegram HTML parse mode
  const body = stripped
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/`/g, '')
    .replace(/_/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Trim to a readable length
  const preview = body.length > 400 ? body.slice(0, 397) + '…' : body;

  const lines: string[] = [
    `<b>${headline}</b>`,
    '',
    preview,
    '',
    `@cryptomoney`,
  ];

  return lines.join('\n').trim();
}

// ─────────────────────────────────────────────────────────────
// SECTION 8 — INTERNAL LINK FETCHER
// ─────────────────────────────────────────────────────────────
interface InternalLink {
  title: string;
  slug: string;
  category: string;
}

async function fetchInternalLinks(category: string): Promise<InternalLink[]> {
  try {
    const { data, error } = await supabase
      .from('posts')
      .select('title, slug, category')
      .eq('is_published', true)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error || !data) return [];

    const sameCategory = data.filter(p => p.category === category);
    const pool = sameCategory.length >= 3 ? sameCategory : data;
    return pool.slice(0, 5);
  } catch {
    return [];
  }
}

function formatInternalLinks(links: InternalLink[], siteBaseUrl: string): string {
  if (!links.length) return 'No internal links available yet.';
  return links
    .map(l => `<a href="${siteBaseUrl}/posts/${l.slug}">${l.title}</a>`)
    .join('\n');
}

// ─────────────────────────────────────────────────────────────
// SECTION 9 — SCHEMA.ORG JSON-LD GENERATOR
// ─────────────────────────────────────────────────────────────
function buildSchemaJsonLd(post: Post, publishedAt: string): string {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: post.title,
    description: post.meta_description,
    keywords: post.tags?.join(', '),
    author: { '@type': 'Person', name: post.author },
    publisher: {
      '@type': 'Organization',
      name: 'YourCryptoSite',
      logo: { '@type': 'ImageObject', url: 'https://yourcryptosite.com/logo.png' },
    },
    datePublished: publishedAt,
    dateModified: publishedAt,
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `https://yourcryptosite.com/posts/${post.slug}`,
    },
    articleSection: post.category,
  };
  return JSON.stringify(schema);
}

// ─────────────────────────────────────────────────────────────
// SECTION 10 — READING TIME ESTIMATOR
// ─────────────────────────────────────────────────────────────
function estimateReadingTime(content: string): number {
  const wordCount = content.replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(wordCount / 200));
}

// ─────────────────────────────────────────────────────────────
// SECTION 11 — QUALITY GATE
// ─────────────────────────────────────────────────────────────
interface QualityResult {
  passes: boolean;
  score: number;
  reasons: string[];
}

function checkQuality(post: Post): QualityResult {
  const reasons: string[] = [];
  let score = 0;

  const plainText  = post.content?.replace(/<[^>]+>/g, '') || '';
  const wordCount  = plainText.split(/\s+/).filter(Boolean).length;
  const sentences  = plainText.split(/[.!?]+/).filter(s => s.trim().length > 10);
  const fullKeyword = post.focus_keyword?.toLowerCase().trim() || '';

  // 1. Word count (25 pts)
  if (wordCount >= 800) {
    score += 25;
  } else if (wordCount >= 700) {
    score += 18;
    reasons.push(`Word count good but short (${wordCount}/800 ideal)`);
  } else if (wordCount >= 500) {
    score += 10;
    reasons.push(`Word count low (${wordCount}/700 minimum)`);
  } else {
    reasons.push(`Word count too short (${wordCount}/500 absolute minimum)`);
  }

  // 2. Sentence variety (5 pts)
  if (sentences.length > 0) {
    const shortSentences = sentences.filter(s => s.trim().split(/\s+/).length < 12).length;
    const shortRatio = shortSentences / sentences.length;
    if (shortRatio < 0.6) {
      score += 5;
    } else {
      reasons.push(`Too many short sentences (${Math.round(shortRatio * 100)}% under 12 words)`);
    }
  }

  // 3. Live price data present (10 pts)
  const hasPriceData = /\$[\d,]+(\.\d+)?/.test(plainText);
  const isCoinlessStory = !post.content?.includes('▲') && !post.content?.includes('▼');
  if (hasPriceData || isCoinlessStory) {
    score += 10;
  } else {
    reasons.push('No live price data embedded');
  }

  // 4. Meta title length 50-60 chars (10 pts)
  const metaTitleLen = post.meta_title?.length || 0;
  if (metaTitleLen >= 50 && metaTitleLen <= 60) {
    score += 10;
  } else {
    reasons.push(`Meta title length off (${metaTitleLen} chars, need 50-60)`);
  }

  // 5. Meta description length 120-160 chars (10 pts)
  const metaDescLen = post.meta_description?.length || 0;
  if (metaDescLen >= 120 && metaDescLen <= 160) {
    score += 10;
  } else {
    reasons.push(`Meta description length off (${metaDescLen} chars, need 120-160)`);
  }

  // 6. Focus keyword in title (10 pts)
  if (fullKeyword && post.title?.toLowerCase().includes(fullKeyword)) {
    score += 10;
  } else {
    reasons.push(`Focus keyword "${fullKeyword}" missing from title`);
  }

  // 7. Keyword density 0.5-2.5% (10 pts)
  if (fullKeyword && wordCount > 0) {
    const escaped   = fullKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const kwMatches = (plainText.toLowerCase().match(new RegExp(escaped, 'g')) || []).length;
    const density   = (kwMatches / wordCount) * 100;
    if (density >= 0.5 && density <= 2.5) {
      score += 10;
    } else {
      reasons.push(`Keyword density off (${density.toFixed(1)}% — aim 0.5-2.5%)`);
    }
  }

  // 8. H2 headings — at least 3 (5 pts)
  const h2Count = (post.content?.match(/<h2>/gi) || []).length;
  if (h2Count >= 3) {
    score += 5;
  } else {
    reasons.push(`Not enough H2 headings (${h2Count}/3)`);
  }

  // 9. Tags — at least 5 (5 pts)
  if (post.tags && post.tags.length >= 5) {
    score += 5;
  } else {
    reasons.push(`Not enough tags (${post.tags?.length || 0}/5 required)`);
  }

  // 10. Internal links present (10 pts)
  const hasInternalLinks = post.content?.includes('/posts/') ?? false;
  if (hasInternalLinks) {
    score += 10;
  } else {
    reasons.push('No internal links found in content');
  }

  return { passes: score >= 75, score, reasons };
}

// ─────────────────────────────────────────────────────────────
// SECTION 12 — FOCUS KEYWORD SANITISER
// ─────────────────────────────────────────────────────────────
const FORBIDDEN_IN_KEYWORD = new Set([
  'sentiment', 'sentiments', 'analysis',
  'landscape', 'ecosystem', 'navigate', 'journey',
  'unlock', 'delve', 'dive',
]);

function sanitiseFocusKeyword(raw: string): string {
  const words = raw
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0 && !FORBIDDEN_IN_KEYWORD.has(w));

  return words.slice(0, 4).join(' ');
}

// ─────────────────────────────────────────────────────────────
// SECTION 13 — AI PROMPT
// ─────────────────────────────────────────────────────────────
function buildPrompt(
  msg: NormalizedMessage,
  category: string,
  coinContext: string,
  internalLinks: string,
  hasCoinData: boolean,
  africanContextRelevant: boolean,
): string {
  const siteBaseUrl = process.env.SITE_BASE_URL || 'https://yourcryptosite.com';

  const coinInstructions = hasCoinData
    ? `
════════════════════════════════════════════
LIVE MARKET DATA — EMBED THESE EXACT FIGURES
════════════════════════════════════════════
${coinContext}

Embed these specific prices, percentages, and market caps naturally in your article.
Do NOT invent numbers. Only use figures from the data above.
ONLY write about the coins listed above — do not bring in any other coins.
`
    : `
════════════════════════════════════════════
MARKET DATA
════════════════════════════════════════════
This story does not involve specific coin prices.
Do NOT invent or insert cryptocurrency prices that are not in the source material.
Write about the topic using factual context only.
`;

  const africanBlock = africanContextRelevant
    ? `
════════════════════════════════════════════
REGIONAL CONTEXT — ONLY BECAUSE THIS STORY IS RELEVANT
════════════════════════════════════════════
This story has direct relevance to African or Kenyan readers.
Where it genuinely fits, reference:
- How this affects African traders or retail investors
- Local exchange availability (e.g. Binance P2P, Yellow Card)
- M-Pesa / mobile money where remittance or payments are involved
- Currency or forex implications for markets like Kenya, Nigeria, or Ghana

Do NOT force African references into sections where they don't naturally fit.
One well-placed, specific regional paragraph is worth more than scattered mentions.
`
    : `
════════════════════════════════════════════
AUDIENCE
════════════════════════════════════════════
Write for a global crypto audience. Do NOT insert African, Kenyan, or M-Pesa
references — this story has no direct regional angle. Keep framing universal.
`;

  return `
You are a senior crypto journalist. Your writing is clear, direct, and grounded in facts.
You write the way a good reporter writes — not the way a content generator writes.

⚠️ NON-NEGOTIABLE: Your "content" field must contain AT LEAST 800 words of readable body text.
Count words as you write. Aim for 900-1000.

════════════════════════════════════════════
PLAIN LANGUAGE RULES — READ THESE FIRST
════════════════════════════════════════════
Your writing must pass a simple test: could a smart 16-year-old read this and understand it?
That means:
• Use short, common words. "Use" not "utilise". "Show" not "demonstrate". "Buy" not "acquire".
• Write short paragraphs — 3-4 sentences max. One idea per paragraph.
• Every sentence must mean something. Cut anything that sounds like filler.
• If you would not say it out loud in a normal conversation, rewrite it.
• Explain jargon the first time you use it (e.g. "DeFi, short for decentralised finance").
• Use active voice. "The SEC approved the ETF" not "The ETF was approved by the SEC".
• Vary sentence length — mix short punchy sentences with longer ones.
• Use specific numbers. "Bitcoin dropped 8% in 4 hours" beats "Bitcoin saw significant losses".

════════════════════════════════════════════
SOURCE MATERIAL
════════════════════════════════════════════
MESSAGE: "${msg.text}"
SOURCE CHANNEL: ${msg.author}
CATEGORY: ${category}
URLS: ${msg.urls.join(', ') || 'none'}
HASHTAGS: ${msg.hashtags.join(', ') || 'none'}
${coinInstructions}
${africanBlock}
════════════════════════════════════════════
INTERNAL LINKS — COPY THESE EXACTLY, DO NOT MODIFY
════════════════════════════════════════════
The following are complete, ready-to-use anchor tags. Copy at least 2 of them
VERBATIM into your content where they fit naturally.

${internalLinks}

RULES — read carefully:
- Copy the full <a href="...">...</a> tag exactly as shown above. Do NOT change the href.
- Do NOT invent, guess, or construct any link that is not in the list above.
- Do NOT paraphrase the anchor text — use it exactly as written.
- If none of the links fit naturally, use the first 2 in the list regardless.
- NEVER write a link like <a href="/posts/some-title-you-made-up">...</a>.

════════════════════════════════════════════
CONTENT STRUCTURE
════════════════════════════════════════════
Write 4-6 H2 sections with headings that fit YOUR story — not generic placeholders.
Good heading examples:
  - "Why This Ruling Changes Everything for Traders"
  - "The Numbers Behind the Sell-Off"
  - "Three Scenarios for the Next 30 Days"
  - "What This Means for Your Portfolio"

Each section needs at least 2-3 substantial paragraphs. No one-liners.
Use specific numbers and data throughout — percentages, dates, dollar figures.

End the article with:
<p><em>Disclaimer: This content is for informational purposes only and does not constitute financial advice. Always do your own research before investing.</em></p>

════════════════════════════════════════════
BANNED WORDS — NEVER USE THESE ANYWHERE
════════════════════════════════════════════
These words make writing sound like a robot. Remove them at every turn:

AI jargon to kill:
"it is worth noting", "it remains to be seen", "in the ever-evolving",
"the crypto space", "as we know", "needless to say", "at the end of the day",
"in the world of crypto", "at the time of writing", "game-changing",
"paradigm", "groundbreaking", "revolutionary" (unless quoting someone),
"transformative", "pioneering", "cutting-edge", "holistic", "robust",
"synergy", "ecosystem" (use "market", "network", or "industry" instead),
"landscape" (use "market" or "industry"), "navigate", "journey" (metaphorical),
"unlock", "dive into", "delve", "empower", "leverage" (metaphorical — ok for trading context)

SEO jargon to kill:
"sentiment", "sentiments", "analysis" (use "breakdown", "picture", "data", "read"),
"significant implications" (say what the implication actually is)

Filler phrases to kill:
"it is important to note", "this is a developing story" (unless it genuinely is),
"time will tell", "only time will tell", "interesting to see"

════════════════════════════════════════════
HTML: Use only <h2>, <p>, <ul>, <li>, <strong>, <em>, <a href="...">.
Do NOT use: <h1>, <h3>, <div>, <span>, <br>, <table>, or anything else.

════════════════════════════════════════════
SEO FIELDS
════════════════════════════════════════════

focus_keyword:
  - 2-4 words. Specific to THIS story. No banned words.
  - Must appear verbatim in title, meta_title, and meta_description.
  - Must appear 5-8 times naturally in content.
  - Examples: "XRP court ruling", "Bitcoin ETF flows", "Solana network outage"

title:
  - 60-80 characters including spaces.
  - Must contain focus_keyword verbatim.
  - Must be specific and click-worthy — not generic.

meta_title:
  - EXACTLY 50-60 characters including spaces. Count every character.
  - Must contain focus_keyword.
  - Under 50 or over 60 = rejected. Rewrite until it fits.

meta_description:
  - EXACTLY 120-160 characters including spaces. Count every character.
  - Must contain focus_keyword and a clear benefit or call to action.

excerpt:
  - 150-200 characters.
  - Must mention focus_keyword and one specific data point from the story.

tags:
  - Exactly 7 lowercase hyphenated tags.
  - No "sentiment", no "analysis", no single-character tags.

════════════════════════════════════════════
FINAL CHECKS BEFORE WRITING JSON
════════════════════════════════════════════
1. Word count in "content" ≥ 800? If not — add sections.
2. meta_title exactly 50-60 chars? Count manually.
3. meta_description exactly 120-160 chars? Count manually.
4. focus_keyword in title verbatim? Fix if not.
5. Any banned words used? Remove them.
6. Does every sentence mean something? Cut filler.

Only write JSON after all 6 checks pass.

════════════════════════════════════════════
OUTPUT: VALID JSON ONLY
No markdown. No backticks. No text before or after. Escape all HTML inside JSON strings.

{
  "title": "60-80 chars, contains focus_keyword, specific and click-worthy",
  "content": "<h2>...</h2><p>...</p>... — minimum 800 words of body text",
  "excerpt": "150-200 chars, focus_keyword + one specific data point",
  "meta_title": "EXACTLY 50-60 chars",
  "meta_description": "EXACTLY 120-160 chars",
  "focus_keyword": "2-4 words, specific, no banned words",
  "tags": ["tag1","tag2","tag3","tag4","tag5","tag6","tag7"]
}
`.trim();
}

// ─────────────────────────────────────────────────────────────
// SECTION 13b — REPAIR PROMPT
// ─────────────────────────────────────────────────────────────
function buildRepairPrompt(
  draft: Post,
  reasons: string[],
  coinContext: string,
  internalLinks: string,
  hasCoinData: boolean,
  siteBaseUrl: string,
): string {
  const plainText  = draft.content?.replace(/<[^>]+>/g, '') || '';
  const wordCount  = plainText.split(/\s+/).filter(Boolean).length;
  const keyword    = draft.focus_keyword || '';
  const escaped    = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const kwMatches  = (plainText.toLowerCase().match(new RegExp(escaped, 'g')) || []).length;
  const density    = wordCount > 0 ? ((kwMatches / wordCount) * 100).toFixed(1) : '0.0';

  const fixes: string[] = [];

  if (reasons.some(r => r.includes('Word count'))) {
    const needed = 800 - wordCount;
    fixes.push(
      `WORD COUNT: Your draft has ${wordCount} words. You need at least ${needed} more words of body text.` +
      ` Add 1-2 new H2 sections with substantive paragraphs. Do not pad — write genuinely useful content.`,
    );
  }

  if (reasons.some(r => r.includes('Keyword density'))) {
    const targetUses = Math.ceil(wordCount * 0.008);
    fixes.push(
      `KEYWORD DENSITY: "${keyword}" appears only ${kwMatches} times (${density}%). ` +
      `You need it to appear ~${targetUses} times (0.5-2.5%). ` +
      `Work it naturally into headings, opening sentences of paragraphs, and the conclusion.`,
    );
  }

  if (reasons.some(r => r.includes('Meta title'))) {
    fixes.push(
      `META TITLE: Current length is ${draft.meta_title?.length ?? 0} chars. ` +
      `Must be EXACTLY 50-60 characters. Rewrite it. Count every character including spaces.`,
    );
  }

  if (reasons.some(r => r.includes('Meta description'))) {
    fixes.push(
      `META DESCRIPTION: Current length is ${draft.meta_description?.length ?? 0} chars. ` +
      `Must be EXACTLY 120-160 characters. Rewrite it. Count every character including spaces.`,
    );
  }

  if (reasons.some(r => r.includes('focus keyword') && r.includes('missing from title'))) {
    fixes.push(
      `TITLE: The focus keyword "${keyword}" must appear verbatim in the title. Rewrite the title to include it.`,
    );
  }

  if (reasons.some(r => r.includes('internal links'))) {
    fixes.push(
      `INTERNAL LINKS: No internal links found. Copy at least 2 of these complete anchor tags VERBATIM into your content:\n` +
      `${internalLinks}\n` +
      `DO NOT modify the href. DO NOT invent links not in this list.`,
    );
  }

  if (reasons.some(r => r.includes('H2'))) {
    fixes.push(`H2 HEADINGS: Add more H2 sections until you have at least 3.`);
  }

  const coinBlock = hasCoinData
    ? `\nLIVE MARKET DATA (embed if not already present):\n${coinContext}\n`
    : '';

  return `
You wrote a draft article that failed our quality checks. Fix ONLY the specific issues listed below.
Keep everything else exactly as it is. Return the complete fixed article as valid JSON.

Also re-read the plain language rules before fixing:
- Short, common words. Active voice. Short paragraphs. No filler sentences.
- No AI jargon: no "it is worth noting", "ecosystem", "landscape", "delve", "navigate", "sentiment".
- Every sentence must mean something concrete.

FOCUS KEYWORD: "${keyword}"
CURRENT WORD COUNT: ${wordCount} (minimum 800 required)
${coinBlock}
════════════════════════════════════════════
ISSUES TO FIX — ADDRESS EVERY ONE
════════════════════════════════════════════
${fixes.map((f, i) => `${i + 1}. ${f}`).join('\n\n')}

════════════════════════════════════════════
CURRENT DRAFT (fix this — do not start from scratch)
════════════════════════════════════════════
${JSON.stringify({
    title:            draft.title,
    content:          draft.content,
    excerpt:          draft.excerpt,
    meta_title:       draft.meta_title,
    meta_description: draft.meta_description,
    focus_keyword:    draft.focus_keyword,
    tags:             draft.tags,
  }, null, 2)}

════════════════════════════════════════════
OUTPUT: VALID JSON ONLY. No markdown. No backticks. No extra text.
Same schema: title, content, excerpt, meta_title, meta_description, focus_keyword, tags.
`.trim();
}

// ─────────────────────────────────────────────────────────────
// SECTION 13b2 — INTERNAL LINK SANITISER
// The AI sometimes constructs its own /posts/invented-slug links
// even when given complete anchor tags. This function runs after
// generation and strips every <a href="/posts/..."> that is NOT
// in the list of real slugs we provided, replacing the tag with
// plain text so readers never hit a 404.
// ─────────────────────────────────────────────────────────────
function sanitiseInternalLinks(content: string, allowedLinks: InternalLink[]): string {
  const allowedSlugs = new Set(allowedLinks.map(l => l.slug));

  // Match every internal anchor tag: <a href="/posts/ANYTHING">...</a>
  return content.replace(
    /<a\s+href="[^"]*\/posts\/([^"]+)"[^>]*>(.*?)<\/a>/gi,
    (_match, slug, anchorText) => {
      if (allowedSlugs.has(slug)) {
        // Real link — keep it exactly as-is
        return _match;
      }
      // Invented slug — strip the link, keep only the anchor text
      console.log(`[aiWorker] 🔗 Removed invented internal link: /posts/${slug}`);
      return anchorText;
    },
  );
}

// ─────────────────────────────────────────────────────────────
// SECTION 13c — POST ASSEMBLER
// ─────────────────────────────────────────────────────────────
function assemblePost(
  generated: Record<string, any>,
  msg: NormalizedMessage,
  category: string,
  publishedAt: string,
  internalLinks: InternalLink[],
): Post {
  const sanitised = { ...generated };
  sanitised.focus_keyword = sanitiseFocusKeyword(sanitised.focus_keyword || '');

  const slug = slugify(sanitised.title);

  // Strip any invented internal links the AI constructed
  sanitised.content = sanitiseInternalLinks(sanitised.content || '', internalLinks);

  const post: Post = {
    title:            sanitised.title,
    slug,
    content:          sanitised.content,
    excerpt:          sanitised.excerpt,
    author:           msg.author,
    tags:             buildTags(sanitised.tags, msg.hashtags, category),
    category,
    referral_links:   buildReferralLinks(msg.urls),
    is_published:     false,
    meta_title:       sanitised.meta_title,
    meta_description: sanitised.meta_description,
    focus_keyword:    sanitised.focus_keyword,
    reading_time_min: estimateReadingTime(sanitised.content),
  };

  post.schema_json_ld = buildSchemaJsonLd(post, publishedAt);
  return post;
}

// ─────────────────────────────────────────────────────────────
// SECTION 14 — HYBRID MODEL SELECTOR
// gpt-5.4      → 500,000 TPM | 500 RPM |   900,000 TPD  (breaking, signals, guides, trending)
// gpt-5.4-mini → 200,000 TPM | 500 RPM | 2,000,000 TPD  (routine — lower cost, higher daily cap)
// Both share 500 RPM so the pipeline won't bottleneck at normal volume.
// max_tokens per call: 6,000 — well within both models' limits.
// ─────────────────────────────────────────────────────────────
const BREAKING_NEWS_KEYWORDS = [
  'sec', 'etf', 'approved', 'banned', 'hack', 'exploit', 'crashed',
  'rug pull', 'bankrupt', 'lawsuit', 'regulation', 'federal reserve',
  'interest rate', 'inflation', 'blackrock', 'fidelity', 'coinbase',
  'binance', 'tether', 'usdt', 'stablecoin', 'depegged', 'listing',
  'delisting', 'halving', 'upgrade', 'fork', 'mainnet',
  'iran', 'russia', 'china ban', 'war', 'sanctions', 'military',
  'attack', 'conflict', 'tariff', 'trump', 'fed chair', 'treasury',
  'executive order', 'nato', 'israel', 'taiwan', 'north korea',
];

function selectModel(
  text: string,
  category: string,
  coinData: CoinData[],
): { model: string; reason: string } {
  const lower = text.toLowerCase();

  if (category === 'signal') {
    return { model: 'gpt-5.4', reason: 'trading signal — accuracy critical' };
  }

  if (category === 'guide') {
    return { model: 'gpt-5.4', reason: 'educational guide — depth required' };
  }

  const hotCoin = coinData.find(c => Math.abs(c.change24h) >= 5);
  if (hotCoin) {
    return {
      model: 'gpt-5.4',
      reason: `trending — ${hotCoin.symbol} moved ${hotCoin.change24h.toFixed(1)}% in 24h`,
    };
  }

  const isBreaking = BREAKING_NEWS_KEYWORDS.some(kw => lower.includes(kw));
  if (isBreaking) {
    return { model: 'gpt-5.4', reason: 'breaking/geopolitical news keyword detected' };
  }

  return { model: 'gpt-5.4-mini', reason: 'routine content — cost optimised' };
}

// ─────────────────────────────────────────────────────────────
// SECTION 15 — PUBLISHING DECISION
// ─────────────────────────────────────────────────────────────
function shouldPublish(source: string, score: number): boolean {
  return source === 'bot' ? score >= 75 : score >= 80;
}

// ─────────────────────────────────────────────────────────────
// SECTION 16 — MAIN WORKER
// ─────────────────────────────────────────────────────────────

// In-memory lock — prevents duplicate jobs for the same message from racing
// through the queue simultaneously before either is saved to the database.
const processingLock = new Set<string>();

function messageFingerprint(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
}

export const aiEnrichWorker = new Worker(
  'ingest_message',
  async (job: Job) => {
    const msg: NormalizedMessage = job.data;

    // ── Step 1: Blog-worthiness filter ───────────────────────
    if (!shouldBlog(msg.text)) {
      const preview = msg.text.slice(0, 80).replace(/\n/g, ' ');
      console.log(`[aiWorker] ⚡ Skipping blog from ${msg.author} — filtered. Preview: "${preview}"`);

      if (msg.text.trim().length > 0) {
        const { sendToChannel } = await import('../workers/telegramNotifier');
        const formatted = formatTelegramQuickUpdate(msg.text, msg.author);
        await sendToChannel(formatted);
      }
      return;
    }

    // ── Step 2a: In-memory race lock ─────────────────────────
    const fingerprint = messageFingerprint(msg.text);
    if (processingLock.has(fingerprint)) {
      console.log(`[aiWorker] 🔒 Race lock hit — already processing this message, skipping`);
      return;
    }
    processingLock.add(fingerprint);

    try {
      // ── Step 2b: Deduplication check (database) ──────────────
      const titlePreview = msg.text.split(/[.\n]/)[0].slice(0, 80);
      const duplicate = await isDuplicate(msg.text, titlePreview);
      if (duplicate) {
        console.log(`[aiWorker] 🔁 Skipping duplicate story from ${msg.author}`);
        return;
      }

    const category = classifyCategory(msg.text);
    const africanContextRelevant = isAfricanContextRelevant(msg.text);

    console.log(
      `[aiWorker] 🤖 Enriching [${category}] from ${msg.author} | ` +
      `Africa context: ${africanContextRelevant ? 'YES' : 'no'} | source: ${msg.source}`,
    );

    // ── Step 3: Detect coins ──────────────────────────────────
    const detectedCoinIds = detectCoins(msg.text);
    const hasCoinData     = detectedCoinIds.length > 0;

    console.log(
      hasCoinData
        ? `[aiWorker] 🪙 Coins detected: ${detectedCoinIds.join(', ')}`
        : `[aiWorker] 🪙 No coins detected — skipping price fetch`,
    );

    const siteBaseUrl = process.env.SITE_BASE_URL || 'https://yourcryptosite.com';

    // ── Step 4: Fetch market data + internal links in parallel ─
    const [coinData, internalLinks] = await Promise.all([
      fetchCoinData(detectedCoinIds),
      fetchInternalLinks(category),
    ]);

    const coinContext      = formatCoinContext(coinData);
    const internalLinksStr = formatInternalLinks(internalLinks, siteBaseUrl);
    console.log(`[aiWorker] 📈 Market + internal links ready (${internalLinks.length} links)`);

    // ── Step 5: Pick model ────────────────────────────────────
    const { model, reason } = selectModel(msg.text, category, coinData);
    console.log(`[aiWorker] 🧠 Model: ${model} (${reason})`);

    const temperature = model === 'gpt-5.4' ? 0.55 : 0.40;

    const systemPrompt = model === 'gpt-5.4'
      ? [
          'You are a senior crypto journalist for a high-authority news platform.',
          'RULE 1 — PLAIN LANGUAGE: Write clearly. Short words. Short paragraphs. Active voice. No AI jargon.',
          'RULE 2 — WORD COUNT: Your "content" field must have 800+ words of readable body text.',
          'RULE 3 — META TITLE: Must be exactly 50-60 characters including spaces.',
          'RULE 4 — COIN DISCIPLINE: Only write about coins in the provided market data.',
          'RULE 5 — NO BANNED WORDS: Never use "sentiment", "ecosystem", "landscape", "delve", "navigate".',
          'RULE 6 — JSON ONLY: Respond with valid JSON only. No markdown, no backticks, no extra text.',
        ].join('\n')
      : [
          'You are a crypto journalist. Write clearly — like a reporter, not a content bot.',
          '1. PLAIN LANGUAGE: Short sentences. Common words. Active voice. No jargon.',
          '2. WORD COUNT: Minimum 800 words of body text.',
          '3. META TITLE: Exactly 50-60 characters including spaces.',
          '4. COIN DISCIPLINE: Only write about coins in the provided market data.',
          '5. Embed ALL price figures provided. Do not invent numbers.',
          '6. Include at least 2 internal links from the list provided.',
          '7. Use 4-6 H2 sections with story-specific headings.',
          '8. NEVER use: "sentiment", "ecosystem", "landscape", "delve", "navigate", "it is worth noting".',
          '9. Return ONLY valid JSON — no markdown, no backticks, no extra text.',
        ].join('\n');

    const publishedAt  = new Date().toISOString();
    let post: Post;

    // ── Helper: call OpenAI and parse JSON ────────────────────
    async function callAI(messages: { role: string; content: string }[]): Promise<Record<string, any>> {
      const response = await openai.chat.completions.create({
        model,
        messages: messages as any,
        temperature,
        max_completion_tokens: 6000,
      });
      const raw   = response.choices[0].message.content || '';
      const clean = raw.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);
    }

    function logPost(p: Post, attempt: 'first' | 'retry'): void {
      const wordCount = p.content?.replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean).length ?? 0;
      console.log(`[aiWorker] ✅ AI post generated (${attempt} attempt):`, {
        model_used:          model,
        title:               p.title,
        slug:                p.slug,
        category:            p.category,
        focus_keyword:       p.focus_keyword,
        word_count:          wordCount,
        reading_time:        `${p.reading_time_min} min`,
        meta_title_len:      p.meta_title?.length,
        meta_desc_len:       p.meta_description?.length,
        tags_count:          p.tags?.length,
        has_prices:          /\$[\d,]+(\.\d+)?/.test(p.content || ''),
        has_int_links:       p.content?.includes('/posts/') ?? false,
        coins_used:          detectedCoinIds,
        african_context:     africanContextRelevant,
      });
    }

    try {
      // ── Step 6: First attempt ─────────────────────────────
      const generated = await callAI([
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: buildPrompt(
            msg, category, coinContext, internalLinksStr, hasCoinData, africanContextRelevant,
          ),
        },
      ]);

      post = assemblePost(generated, msg, category, publishedAt, internalLinks);
      logPost(post, 'first');

      // ── Step 7: Quality check — repair if needed ──────────
      const firstQuality = checkQuality(post);
      const publishThreshold = msg.source === 'bot' ? 75 : 80;

      if (!firstQuality.passes || firstQuality.score < publishThreshold) {
        console.log(
          `[aiWorker] 🔧 First attempt score: ${firstQuality.score}/100 — running repair retry...`,
        );
        console.log('[aiWorker] 🔧 Issues to fix:', firstQuality.reasons);

        try {
          const repaired = await callAI([
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: buildRepairPrompt(
                post,
                firstQuality.reasons,
                coinContext,
                internalLinksStr,
                hasCoinData,
                siteBaseUrl,
              ),
            },
          ]);

          const repairedPost = assemblePost(repaired, msg, category, publishedAt, internalLinks);
          const retryQuality = checkQuality(repairedPost);

          logPost(repairedPost, 'retry');
          console.log(
            `[aiWorker] 🔧 Repair score: ${retryQuality.score}/100 ` +
            `(was ${firstQuality.score}/100) — ` +
            (retryQuality.score > firstQuality.score ? '✅ improved' : '⚠️ no improvement, keeping retry anyway'),
          );

          post = repairedPost;

        } catch (retryErr) {
          console.warn('[aiWorker] ⚠️ Repair retry failed, keeping first attempt:', retryErr);
        }
      }

    } catch (err) {
      console.error('[aiWorker] ⚠️ AI failed, using fallback:', err);
      const title = msg.text.split(/[.\n]/)[0].slice(0, 80);
      post = {
        title,
        slug:             slugify(title),
        content:          `<p>${msg.text}</p>`,
        excerpt:          msg.text.slice(0, 200),
        author:           msg.author,
        tags:             buildTags(undefined, msg.hashtags, category),
        category,
        referral_links:   buildReferralLinks(msg.urls),
        is_published:     false,
        meta_title:       title.slice(0, 60),
        meta_description: msg.text.slice(0, 155),
        focus_keyword:    sanitiseFocusKeyword(msg.hashtags[0] || category),
        reading_time_min: 1,
      };
    }

    // ── Step 8: Final quality gate + publishing decision ─────
    const quality = checkQuality(post);
    const publish = shouldPublish(msg.source, quality.score);
    post.is_published = publish;

    const sourceLabel  = msg.source === 'bot' ? 'bot (threshold: 75)' : 'userbot (threshold: 80)';
    const publishLabel = publish ? '✅ Auto-publishing' : '📝 Saving as draft';

    console.log(
      `[aiWorker] 📊 Quality: ${quality.score}/100 | Source: ${sourceLabel} | ${publishLabel}`,
    );

    if (!publish) {
      console.log('[aiWorker] ⚠️ Quality issues:', quality.reasons);
    }

      if (publish) {
        await storeQueue.add('store_post', post);
        console.log(`[aiWorker] 📤 → store queue: ${post.slug}`);
      } else {
        await draftQueue.add('draft_post', post);
        console.log(`[aiWorker] 📥 → draft queue: ${post.slug}`);
      }
    } finally {
      // Always release the lock so retries and future messages aren't blocked
      processingLock.delete(fingerprint);
    }
  },
  { connection: redisConnection },
);

aiEnrichWorker.on('completed', job => {
  console.log(`[aiWorker] ✅ Job ${job.id} completed`);
});

aiEnrichWorker.on('failed', (job, err) => {
  console.error(`[aiWorker] ❌ Job ${job?.id} failed:`, err.message);
});