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
// SECTION 4 — SLUG GENERATOR
// Strips AI-flavoured filler words that pollute slugs.
// ─────────────────────────────────────────────────────────────

// Words that add zero SEO value and make slugs look AI-generated.
const SLUG_FILLER = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with',
  'is','are','was','were','be','been','has','have','had','will','would',
  'that','this','it','as','by','from','its','their','they','about',
  // AI-slop fillers
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
// Scrubs banned words before they reach the post.
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

/**
 * Detects coins mentioned in the text.
 * IMPORTANT: Does NOT fall back to Bitcoin when no coin is found.
 * The caller decides what to do with an empty array.
 */
function detectCoins(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const [keyword, coinId] of Object.entries(COIN_MAP)) {
    if (lower.includes(keyword)) found.add(coinId);
  }
  // No fallback — only return coins that are actually in the text.
  return [...found].slice(0, 5);
}

async function fetchCoinData(coinIds: string[]): Promise<CoinData[]> {
  // Nothing to fetch — don't hit CoinGecko at all.
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

function formatInternalLinks(links: InternalLink[]): string {
  if (!links.length) return 'No internal links available yet.';
  return links
    .map(l => `- "${l.title}" → /posts/${l.slug}`)
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
// Scores the post across 10 dimensions. Pass threshold: 75.
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

  // 3. Live price data present — only if coins were actually detected (10 pts)
  // If coinContext was "No specific coin price data", we don't penalise.
  const hasPriceData = /\$[\d,]+(\.\d+)?/.test(plainText);
  const isCoinlessStory = !post.content?.includes('▲') && !post.content?.includes('▼');
  if (hasPriceData || isCoinlessStory) {
    score += 10;
  } else {
    reasons.push('No live price data embedded — add prices or ensure no coins are in source text');
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

  // 6. Full keyword phrase in title (10 pts)
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
      reasons.push(`Keyword density off (${density.toFixed(1)}% for "${fullKeyword}" — aim 0.5-2.5%)`);
    }
  }

  // 8. H2 headings — at least 3 (relaxed from 4) (5 pts)
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
// Strips banned words, caps at 4 words.
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
// Loosened structure: no mandatory 5-section straitjacket.
// Writer chooses natural headings that fit the story.
// Coin rule: ONLY write about coins in the provided data.
// ─────────────────────────────────────────────────────────────
function buildPrompt(
  msg: NormalizedMessage,
  category: string,
  coinContext: string,
  internalLinks: string,
  hasCoinData: boolean,
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

  return `
You are a senior crypto journalist with 10 years of experience at Bloomberg, CoinDesk, and The Block.
Your writing is sharp, direct, and analytical. You write for a Kenyan and broader African audience —
reference M-Pesa, local exchange availability, or African market context when it genuinely fits the story.

⚠️ NON-NEGOTIABLE: Your "content" field must contain AT LEAST 800 words of readable body text.
Strip all HTML tags mentally and count. If you are under 800 words, keep writing. Aim for 900-1000.

════════════════════════════════════════════
SOURCE MATERIAL
════════════════════════════════════════════
MESSAGE: "${msg.text}"
SOURCE CHANNEL: ${msg.author}
CATEGORY: ${category}
URLS: ${msg.urls.join(', ') || 'none'}
HASHTAGS: ${msg.hashtags.join(', ') || 'none'}
${coinInstructions}
════════════════════════════════════════════
INTERNAL LINKS — INCLUDE AT LEAST 2
════════════════════════════════════════════
${internalLinks}
Link to at least 2 of these naturally within your content:
<a href="${siteBaseUrl}/posts/SLUG">Anchor text that reads naturally</a>
Never use "click here" or "read more" as anchor text.

════════════════════════════════════════════
CONTENT STRUCTURE
════════════════════════════════════════════
Write 4-6 H2 sections with headings that fit YOUR story — do not use generic placeholders.
Good heading examples:
  - "Why This Ruling Changes Everything for African Traders"
  - "The Numbers Behind the Sell-Off"
  - "Three Scenarios for the Next 30 Days"
  - "What Kenyan Investors Need to Know Right Now"

Each section needs at least 2-3 substantial paragraphs. No one-liners.
Vary sentence length: mix short punchy sentences with longer analytical ones.
Use specific numbers and data throughout — percentages, dates, dollar figures.

End the article with:
<p><em>Disclaimer: This content is for informational purposes only and does not constitute financial advice. Always do your own research before investing.</em></p>

════════════════════════════════════════════
BANNED WORDS — NEVER USE THESE
════════════════════════════════════════════
Anywhere in the article, title, meta fields, or tags:
"sentiment", "sentiments", "analysis" (use "breakdown", "picture", "data", "read" instead)
"it remains to be seen", "time will tell", "significant implications"
"the crypto space", "as we know", "in the world of crypto"
"at the time of writing", "it's worth noting", "needless to say"
"at the end of the day", "landscape", "navigate", "journey" (metaphorical use)
"unlock", "dive into", "delve"

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

Only write JSON after all 5 checks pass.

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
// Called only when the first attempt fails quality checks.
// Passes the existing draft back to the model with surgical
// instructions covering only the specific issues found.
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

  // Build targeted fix instructions from actual failure reasons
  const fixes: string[] = [];

  if (reasons.some(r => r.includes('Word count'))) {
    const needed = 800 - wordCount;
    fixes.push(
      `WORD COUNT: Your draft has ${wordCount} words. You need at least ${needed} more words of body text.` +
      ` Add 1-2 new H2 sections with substantive paragraphs. Do not pad — write genuinely useful content.`,
    );
  }

  if (reasons.some(r => r.includes('Keyword density'))) {
    const targetUses = Math.ceil(wordCount * 0.008); // ~0.8% as safe midpoint
    fixes.push(
      `KEYWORD DENSITY: "${keyword}" appears only ${kwMatches} times (${density}%). ` +
      `You need it to appear ~${targetUses} times (0.5-2.5%). ` +
      `Work it naturally into headings, opening sentences of paragraphs, and the conclusion. ` +
      `Do NOT force it awkwardly — find natural spots where it genuinely fits.`,
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
      `INTERNAL LINKS: No internal links found. Add at least 2 links from this list:\n${internalLinks}\n` +
      `Use: <a href="${siteBaseUrl}/posts/SLUG">natural anchor text</a>`,
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
Keep everything else exactly as it is — do not change the title, focus_keyword, tags, or any content
that is already correct. Return the complete fixed article as valid JSON (same schema as before).

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
// SECTION 13c — POST ASSEMBLER
// Converts raw AI JSON into a typed Post object.
// Extracted so both the first attempt and repair retry use it.
// ─────────────────────────────────────────────────────────────
function assemblePost(
  generated: Record<string, any>,
  msg: NormalizedMessage,
  category: string,
  publishedAt: string,
): Post {
  const sanitised = { ...generated };
  sanitised.focus_keyword = sanitiseFocusKeyword(sanitised.focus_keyword || '');

  // Build a shell first so schema can reference the slug
  const slug = slugify(sanitised.title);

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
    return { model: 'gpt-4o', reason: 'trading signal — accuracy critical' };
  }

  if (category === 'guide') {
    return { model: 'gpt-4o', reason: 'educational guide — depth required' };
  }

  const hotCoin = coinData.find(c => Math.abs(c.change24h) >= 5);
  if (hotCoin) {
    return {
      model: 'gpt-4o',
      reason: `trending — ${hotCoin.symbol} moved ${hotCoin.change24h.toFixed(1)}% in 24h`,
    };
  }

  const isBreaking = BREAKING_NEWS_KEYWORDS.some(kw => lower.includes(kw));
  if (isBreaking) {
    return { model: 'gpt-4o', reason: 'breaking/geopolitical news keyword detected' };
  }

  return { model: 'gpt-4o-mini', reason: 'routine content — cost optimised' };
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
export const aiEnrichWorker = new Worker(
  'ingest_message',
  async (job: Job) => {
    const msg: NormalizedMessage = job.data;

    // ── Step 1: Blog-worthiness filter ───────────────────────
    if (!shouldBlog(msg.text)) {
      const preview = msg.text.slice(0, 80).replace(/\n/g, ' ');
      console.log(`[aiWorker] ⚡ Skipping blog from ${msg.author} — filtered by shouldBlog. Preview: "${preview}"`);

      // Strip markdown syntax that breaks Telegram's HTML parse mode,
      // then trim to 300 chars for the quick update.
      const cleanText = msg.text
        .replace(/\*\*/g, '')   // remove bold markdown **
        .replace(/\*/g, '')     // remove italic markdown *
        .replace(/`/g, '')      // remove code ticks
        .replace(/_/g, ' ')     // replace underscores used as italic
        .trim();

      // Only send to Telegram if there's actual content to show
      if (cleanText.length > 0) {
        const { sendToChannel } = await import('../workers/telegramNotifier');
        const telegramPreview = cleanText.length > 300 ? cleanText.slice(0, 300) + '…' : cleanText;
        await sendToChannel(`⚡ <b>Quick Update</b>\n\n${telegramPreview}`);
      }
      return;
    }

    // ── Step 2: Deduplication check ──────────────────────────
    const titlePreview = msg.text.split(/[.\n]/)[0].slice(0, 80);
    const duplicate = await isDuplicate(msg.text, titlePreview);
    if (duplicate) {
      console.log(`[aiWorker] 🔁 Skipping duplicate story from ${msg.author}`);
      return;
    }

    const category = classifyCategory(msg.text);
    console.log(`[aiWorker] 🤖 Enriching [${category}] from ${msg.author} (source: ${msg.source})...`);

    // ── Step 3: Detect coins — only what's actually in the text ─
    const detectedCoinIds = detectCoins(msg.text);
    const hasCoinData     = detectedCoinIds.length > 0;

    console.log(
      hasCoinData
        ? `[aiWorker] 🪙 Coins detected: ${detectedCoinIds.join(', ')}`
        : `[aiWorker] 🪙 No coins detected — skipping price fetch`,
    );

    // ── Step 4: Fetch market data + internal links in parallel ─
    const [coinData, internalLinks] = await Promise.all([
      fetchCoinData(detectedCoinIds),
      fetchInternalLinks(category),
    ]);

    const coinContext      = formatCoinContext(coinData);
    const internalLinksStr = formatInternalLinks(internalLinks);
    console.log(`[aiWorker] 📈 Market + internal links ready (${internalLinks.length} links)`);

    // ── Step 5: Pick model ────────────────────────────────────
    const { model, reason } = selectModel(msg.text, category, coinData);
    console.log(`[aiWorker] 🧠 Model: ${model} (${reason})`);

    const temperature = model === 'gpt-4o' ? 0.55 : 0.40;

    const systemPrompt = model === 'gpt-4o'
      ? [
          'You are a senior crypto journalist for a high-authority African news platform.',
          'RULE 1 — WORD COUNT: Your "content" field must have 800+ words of readable body text. Count as you write.',
          'RULE 2 — META TITLE: Must be exactly 50-60 characters including spaces. Count every character.',
          'RULE 3 — COIN DISCIPLINE: Only write about coins mentioned in the provided market data. Never default to Bitcoin.',
          'RULE 4 — NO BANNED WORDS: Never use "sentiment", "analysis", "landscape", "delve", "dive into" anywhere.',
          'RULE 5 — JSON ONLY: Respond with valid JSON only. No markdown, no backticks, no extra text.',
        ].join('\n')
      : [
          'You are a crypto journalist. Follow every rule exactly:',
          '1. WORD COUNT: Minimum 800 words of body text. Count as you write.',
          '2. META TITLE: Exactly 50-60 characters including spaces — count every character.',
          '3. COIN DISCIPLINE: Only write about coins in the provided market data. Never default to Bitcoin.',
          '4. Embed ALL price figures provided. Do not invent numbers.',
          '5. Include at least 2 internal links from the list provided.',
          '6. Use 4-6 H2 sections with story-specific headings (not generic placeholders).',
          '7. NEVER use: "sentiment", "analysis", "landscape", "delve", "dive into" anywhere.',
          '8. focus_keyword must be 2-4 words, specific to THIS story.',
          '9. Return ONLY valid JSON — no markdown, no backticks, no extra text.',
        ].join('\n');

    const publishedAt  = new Date().toISOString();
    const siteBaseUrl  = process.env.SITE_BASE_URL || 'https://yourcryptosite.com';
    let post: Post;

    // ── Helper: call OpenAI and parse JSON ──────────────────
    async function callAI(messages: { role: string; content: string }[]): Promise<Record<string, any>> {
      const response = await openai.chat.completions.create({
        model,
        messages: messages as any,
        temperature,
        max_tokens: 6000,
      });
      const raw   = response.choices[0].message.content || '';
      const clean = raw.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);
    }

    // ── Helper: log post stats ──────────────────────────────
    function logPost(p: Post, attempt: 'first' | 'retry'): void {
      const wordCount = p.content?.replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean).length ?? 0;
      console.log(`[aiWorker] ✅ AI post generated (${attempt} attempt):`, {
        model_used:     model,
        title:          p.title,
        slug:           p.slug,
        category:       p.category,
        focus_keyword:  p.focus_keyword,
        word_count:     wordCount,
        reading_time:   `${p.reading_time_min} min`,
        meta_title_len: p.meta_title?.length,
        meta_desc_len:  p.meta_description?.length,
        tags_count:     p.tags?.length,
        has_prices:     /\$[\d,]+(\.\d+)?/.test(p.content || ''),
        has_int_links:  p.content?.includes('/posts/') ?? false,
        coins_used:     detectedCoinIds,
      });
    }

    try {
      // ── Step 6: First attempt ─────────────────────────────
      const generated = await callAI([
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: buildPrompt(msg, category, coinContext, internalLinksStr, hasCoinData) },
      ]);

      post = assemblePost(generated, msg, category, publishedAt);
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

          const repairedPost = assemblePost(repaired, msg, category, publishedAt);
          const retryQuality = checkQuality(repairedPost);

          logPost(repairedPost, 'retry');
          console.log(
            `[aiWorker] 🔧 Repair score: ${retryQuality.score}/100 ` +
            `(was ${firstQuality.score}/100) — ` +
            (retryQuality.score > firstQuality.score ? '✅ improved' : '⚠️ no improvement, keeping retry anyway'),
          );

          // Always use the retry result — it's at least as focused on the issues
          post = repairedPost;

        } catch (retryErr) {
          console.warn('[aiWorker] ⚠️ Repair retry failed, keeping first attempt:', retryErr);
          // post stays as the first attempt
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
  },
  { connection: redisConnection },
);

aiEnrichWorker.on('completed', job => {
  console.log(`[aiWorker] ✅ Job ${job.id} completed`);
});

aiEnrichWorker.on('failed', (job, err) => {
  console.error(`[aiWorker] ❌ Job ${job?.id} failed:`, err.message);
});