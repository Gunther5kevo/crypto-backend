import { Worker, Job } from 'bullmq';
import OpenAI from 'openai';
import { redisConnection, storeQueue, draftQueue } from '../queue/queues';
import { NormalizedMessage } from '../types/message';
import { Post, ReferralLink } from '../supabase/client';
import { supabase } from '../supabase/client';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Blog-worthiness filter ────────────────────────────────────
// Returns false for messages that should only go to Telegram,
// not become full blog posts.
function shouldBlog(text: string): boolean {
  const lower = text.toLowerCase().trim();

  // Too short to be a meaningful article
  if (text.split(/\s+/).length < 20) return false;

  // Pure price-ticker patterns: "BTC: $98,500 ▲2.3%" style messages
  // These are useful as Telegram alerts but not as blog content
  const priceTicker = /^[a-z\s/]+:\s*\$[\d,]+(\.\d+)?\s*[▲▼]?\s*[\d.]+%/i;
  if (priceTicker.test(lower)) return false;

  // Messages that are mostly just a price table / list of coins + prices
  const lines = text.split('\n').filter(l => l.trim());
  const priceLines = lines.filter(l => /\$[\d,]+(\.\d+)?/.test(l));
  if (lines.length > 2 && priceLines.length / lines.length > 0.6) return false;

  // Common low-value patterns that don't deserve a full post
  const lowValuePatterns = [
    /^(bitcoin|btc|eth|ethereum|crypto)\s+(is\s+)?(now\s+)?(trading|at|up|down)\s+/i,
    /^(market\s+)?(update|recap|summary)\s*:/i,         // bare "Market Update: BTC $98k"
    /^\d+[\d\s.,]+$/, // pure numbers
  ];
  if (lowValuePatterns.some(p => p.test(lower))) return false;

  return true;
}

// ── Deduplication ────────────────────────────────────────────
// Check if a near-identical post was already stored in the last 24h.
// Uses a simple keyword overlap approach — no embeddings needed.
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

    // Extract meaningful keywords from the incoming text (ignore stop words)
    const stopWords = new Set([
      'the','a','an','and','or','but','in','on','at','to','for','of','with',
      'is','are','was','were','be','been','has','have','had','will','would',
      'that','this','it','as','by','from','its','their','they','about','after',
      'bitcoin','crypto','blockchain', // too common to be discriminating
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

      // >60% keyword overlap = likely the same story
      if (overlap > 0.6) {
        console.log(`[aiWorker] 🔁 Duplicate detected (${Math.round(overlap * 100)}% overlap) with: "${post.title}"`);
        return true;
      }
    }

    return false;
  } catch (err) {
    // If the check fails, allow the post through — better a duplicate than a gap
    console.warn('[aiWorker] ⚠️ Dedup check failed, allowing post:', err);
    return false;
  }
}

// ── Category classifier ───────────────────────────────────────
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
  const signalCount = signalTerms.filter(t => lower.includes(t)).length;
  if (signalCount >= 2) return 'signal';

  return 'news';
}

// ── Slug generator ───────────────────────────────────────────
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .slice(0, 80);
}

// ── Referral links ───────────────────────────────────────────
function buildReferralLinks(urls: string[]): ReferralLink[] {
  return urls.map(url => {
    let type: ReferralLink['type'] = 'external';
    if (url.includes('airdrop') || url.includes('claim')) type = 'airdrop';
    else if (url.includes('ref=') || url.includes('referral')) type = 'referral';
    return { url, type };
  });
}

// ── Tag builder ──────────────────────────────────────────────
function buildTags(
  aiTags: string[] | undefined,
  hashtags: string[],
  category: string,
): string[] {
  if (aiTags && aiTags.length >= 3) return aiTags;
  if (hashtags.length >= 3) return hashtags;
  return [category, 'crypto', 'blockchain', 'defi', 'web3'];
}

// ── Live market enrichment ───────────────────────────────────
interface CoinData {
  symbol: string;
  price: number;
  change24h: number;
  marketCap: number;
  volume24h: number;
}

function detectCoins(text: string): string[] {
  const knownCoins: Record<string, string> = {
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
  };

  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const [keyword, coinId] of Object.entries(knownCoins)) {
    if (lower.includes(keyword)) found.add(coinId);
  }
  found.add('bitcoin');
  return [...found].slice(0, 4);
}

async function fetchCoinData(coinIds: string[]): Promise<CoinData[]> {
  try {
    const ids = coinIds.join(',');
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=false&price_change_percentage=24h`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data = await res.json();
    return data.map((c: any) => ({
      symbol:    c.symbol.toUpperCase(),
      price:     c.current_price,
      change24h: c.price_change_percentage_24h ?? 0,
      marketCap: c.market_cap,
      volume24h: c.total_volume,
    }));
  } catch (err) {
    console.warn('[aiWorker] ⚠️ CoinGecko fetch failed, continuing without market data:', err);
    return [];
  }
}

function formatCoinContext(coins: CoinData[]): string {
  if (!coins.length) return 'Market data unavailable at time of writing.';
  return coins
    .map(c => {
      const direction = c.change24h >= 0 ? '▲' : '▼';
      const changeAbs = Math.abs(c.change24h).toFixed(2);
      const price = c.price < 1
        ? `$${c.price.toFixed(4)}`
        : `$${c.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
      const vol = `$${(c.volume24h / 1e6).toFixed(1)}M`;
      return `${c.symbol}: ${price} (${direction}${changeAbs}% 24h) | Vol: ${vol}`;
    })
    .join('\n');
}

// ── SEO & Content Quality Gate ───────────────────────────────
interface QualityResult {
  passes: boolean;
  score: number;
  reasons: string[];
}

function checkQuality(post: Post): QualityResult {
  const reasons: string[] = [];
  let score = 0;

  const plainText = post.content?.replace(/<[^>]+>/g, '') || '';
  const wordCount = plainText.split(/\s+/).filter(Boolean).length;
  const sentences = plainText.split(/[.!?]+/).filter(s => s.trim().length > 10);

  const rawKeyword  = post.focus_keyword?.toLowerCase().trim() || '';
  const rootKeyword = rawKeyword.split(/\s+/)[0];

  if (wordCount >= 600) {
    score += 20;
  } else if (wordCount >= 400) {
    score += 10;
    reasons.push(`Word count low (${wordCount}/600)`);
  } else {
    reasons.push(`Word count too short (${wordCount}/400 minimum)`);
  }

  if (sentences.length > 0) {
    const shortSentences = sentences.filter(
      s => s.trim().split(/\s+/).length < 12
    ).length;
    const shortRatio = shortSentences / sentences.length;
    if (shortRatio < 0.6) {
      score += 10;
    } else {
      reasons.push(`Too many short sentences (${Math.round(shortRatio * 100)}% under 12 words)`);
    }
  }

  const hasPriceData = /\$[\d,]+(\.\d+)?/.test(plainText);
  if (hasPriceData) {
    score += 10;
  } else {
    reasons.push('No live price data found in content');
  }

  const metaTitleLen = post.meta_title?.length || 0;
  if (metaTitleLen >= 50 && metaTitleLen <= 60) {
    score += 10;
  } else {
    reasons.push(`Meta title length off (${metaTitleLen} chars, need 50-60)`);
  }

  const metaDescLen = post.meta_description?.length || 0;
  if (metaDescLen >= 120 && metaDescLen <= 160) {
    score += 10;
  } else {
    reasons.push(`Meta description length off (${metaDescLen} chars, need 120-160)`);
  }

  if (rootKeyword && post.title?.toLowerCase().includes(rootKeyword)) {
    score += 10;
  } else {
    reasons.push(`Focus keyword root "${rootKeyword}" missing from title`);
  }

  if (rootKeyword && plainText) {
    const escaped = rootKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const kwMatches = (plainText.toLowerCase().match(new RegExp(escaped, 'g')) || []).length;
    const density = (kwMatches / wordCount) * 100;
    if (density >= 0.5 && density <= 2.5) {
      score += 10;
    } else {
      reasons.push(`Keyword density off (${density.toFixed(1)}% for "${rootKeyword}" — aim 0.5-2.5%)`);
    }
  }

  const h2Count = (post.content?.match(/<h2>/gi) || []).length;
  if (h2Count >= 3) {
    score += 5;
  } else {
    reasons.push(`Not enough H2 headings (${h2Count}/3)`);
  }

  if (post.tags && post.tags.length >= 3) {
    score += 5;
  } else {
    reasons.push('Not enough tags (need 3+)');
  }

  return { passes: score >= 70, score, reasons };
}

// ── AI Prompt ────────────────────────────────────────────────
function buildPrompt(
  msg: NormalizedMessage,
  category: string,
  coinContext: string,
): string {
  return `
You are a professional crypto journalist writing an original, insight-driven blog post for a crypto education platform.

SOURCE MESSAGE:
"${msg.text}"

SOURCE CHANNEL: ${msg.author}
CATEGORY: ${category}
URLS FOUND: ${msg.urls.join(', ') || 'none'}
HASHTAGS: ${msg.hashtags.join(', ') || 'none'}

LIVE MARKET DATA (embed these exact figures in your content — this is what makes the post original and not generic):
${coinContext}

═══════════════════════════════════════
CONTENT REQUIREMENTS — READ CAREFULLY
═══════════════════════════════════════

WORD COUNT: You MUST write at least 700 words of readable text (excluding HTML tags).
Count as you write. If you are under 700 words, keep writing until you reach it.
Short posts will be rejected.

STRUCTURE: Use exactly 5 H2 sections:
  1. What Happened
  2. Market Context (embed the live price data here — use the exact figures provided)
  3. What the Data Tells Us (take a clear analytical position — do not hedge)
  4. What to Watch Next
  5. Key Takeaways

WRITING RULES:
- Each H2 section must have at least 3 full paragraphs
- Mix sentence lengths: short punchy sentences AND longer analytical ones
- Embed specific prices and percentages from the live market data above
- Take a clear stance — agree or disagree with the signal, explain why
- Do NOT use filler: "this could have significant implications", "it remains to be seen", "time will tell"
- Tone: sharp, informed, direct — Bloomberg crypto desk style
- End with: <p><em>Disclaimer: This content is for informational purposes only and does not constitute financial advice.</em></p>
- HTML tags allowed: <h2>, <p>, <ul>, <li>, <strong>, <em> only

═══════════════════════════════════════
SEO REQUIREMENTS — EXACT CONSTRAINTS
═══════════════════════════════════════

focus_keyword: 1 to 2 words MAXIMUM (e.g. "Bitcoin", "crypto regulation", "Ethereum ETF")
  — NEVER a 3-word phrase, NEVER a full sentence
  — The focus_keyword MUST appear in the title verbatim

title: Must contain the focus_keyword verbatim. 60-80 total characters.

meta_title: Must contain focus_keyword. EXACTLY 50-60 characters. Count them.

meta_description: Must contain focus_keyword. EXACTLY 120-160 characters. Count them.

Use the focus_keyword 5-8 times naturally throughout the content body.

tags: exactly 5 lowercase hyphenated tags relevant to the post topic.

═══════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════

Respond with VALID JSON ONLY. No markdown fences, no backticks, no commentary before or after.

{
  "title": "60-80 chars, contains focus_keyword verbatim",
  "content": "<h2>What Happened</h2><p>...</p>... 700+ words with live prices embedded",
  "excerpt": "150-200 char summary mentioning focus_keyword and one specific data point",
  "meta_title": "exactly 50-60 chars, contains focus_keyword",
  "meta_description": "exactly 120-160 chars, contains focus_keyword",
  "focus_keyword": "1-2 words maximum",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
}
`.trim();
}

// ── Publishing decision ───────────────────────────────────────
function shouldPublish(source: string, score: number): boolean {
  return source === 'bot' ? score >= 70 : score >= 75;
}

// ── Main worker ──────────────────────────────────────────────
export const aiEnrichWorker = new Worker(
  'ingest_message',
  async (job: Job) => {
    const msg: NormalizedMessage = job.data;

    // ── Step 1: Blog-worthiness filter ───────────────────────
    // Price tickers and very short messages go straight to Telegram,
    // they don't need a full blog post written about them.
    if (!shouldBlog(msg.text)) {
      console.log(`[aiWorker] ⚡ Skipping blog — low-value/price-ticker message from ${msg.author}. Routing to Telegram only.`);

      const { sendToChannel } = await import('../workers/telegramNotifier');
      const preview = msg.text.length > 300 ? msg.text.slice(0, 300) + '…' : msg.text;
      await sendToChannel(`⚡ <b>Quick Update</b>\n\n${preview}`);
      return;
    }

    // ── Step 2: Deduplication check ──────────────────────────
    const duplicate = await isDuplicate(msg.text, msg.text.split(/[.\n]/)[0].slice(0, 80));
    if (duplicate) {
      console.log(`[aiWorker] 🔁 Skipping duplicate story from ${msg.author}`);
      return;
    }

    const category = classifyCategory(msg.text);
    console.log(`[aiWorker] 🤖 Enriching message from ${msg.author} (source: ${msg.source})...`);

    const coinIds     = detectCoins(msg.text);
    const coinData    = await fetchCoinData(coinIds);
    const coinContext = formatCoinContext(coinData);
    console.log(`[aiWorker] 📈 Market context fetched for: ${coinIds.join(', ')}`);

    let post: Post;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You are a professional crypto journalist. You write original, data-driven posts of at least 700 words. ' +
              'You always embed live market data into your analysis. ' +
              'You always respond with valid JSON only — no markdown, no backticks, no extra text.',
          },
          {
            role: 'user',
            content: buildPrompt(msg, category, coinContext),
          },
        ],
        temperature: 0.65,
        max_tokens: 6000,
      });

      const raw       = response.choices[0].message.content || '';
      const clean     = raw.replace(/```json|```/g, '').trim();
      const generated = JSON.parse(clean);

      post = {
        title:            generated.title,
        slug:             slugify(generated.title),
        content:          generated.content,
        excerpt:          generated.excerpt,
        author:           msg.author,
        tags:             buildTags(generated.tags, msg.hashtags, category),
        category,
        referral_links:   buildReferralLinks(msg.urls),
        is_published:     false,
        meta_title:       generated.meta_title,
        meta_description: generated.meta_description,
        focus_keyword:    generated.focus_keyword,
      };

      const wordCount = post.content?.replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean).length ?? 0;

      console.log('[aiWorker] ✅ AI generated post:', {
        title:            post.title,
        slug:             post.slug,
        category:         post.category,
        tags:             post.tags,
        focus_keyword:    post.focus_keyword,
        word_count:       wordCount,
        meta_title_len:   post.meta_title?.length,
        meta_desc_len:    post.meta_description?.length,
        has_price_data:   /\$[\d,]+(\.\d+)?/.test(post.content || ''),
      });
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
        focus_keyword:    msg.hashtags[0] || category,
      };
    }

    // ── Step 3: Quality gate + publishing decision ────────────
    const quality = checkQuality(post);
    const publish = shouldPublish(msg.source, quality.score);
    post.is_published = publish;

    const sourceLabel  = msg.source === 'bot' ? 'bot (threshold: 70)' : 'userbot (threshold: 75)';
    const publishLabel = publish ? '✅ Auto-publishing' : '📝 Saving as draft';

    console.log(
      `[aiWorker] 📊 Quality score: ${quality.score}/100 | Source: ${sourceLabel} | ${publishLabel}`,
    );

    if (!publish) {
      console.log('[aiWorker] ⚠️ Quality issues:', quality.reasons);
    }

    if (publish) {
      await storeQueue.add('store_post', post);
      console.log(`[aiWorker] 📤 Pushed to store queue (will notify): ${post.slug}`);
    } else {
      await draftQueue.add('draft_post', post);
      console.log(`[aiWorker] 📥 Pushed to draft queue (silent): ${post.slug}`);
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