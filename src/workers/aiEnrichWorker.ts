import { Worker, Job } from 'bullmq';
import OpenAI from 'openai';
import { redisConnection, storeQueue, draftQueue } from '../queue/queues';
import { NormalizedMessage } from '../types/message';
import { Post, ReferralLink } from '../supabase/client';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Category classifier ──────────────────────────────────────
function classifyCategory(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('airdrop') || lower.includes('claim') || lower.includes('free token'))
    return 'airdrop';
  if (
    lower.includes('signal') || lower.includes('buy') || lower.includes('sell') ||
    lower.includes('long') || lower.includes('short') || lower.includes('entry') ||
    lower.includes('tp') || lower.includes('sl')
  )
    return 'signal';
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

// Detect which coins are mentioned in the text
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

  // Always include bitcoin as baseline market context
  found.add('bitcoin');

  return [...found].slice(0, 4); // cap at 4 to keep prompt manageable
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
  const keyword = post.focus_keyword?.toLowerCase() || '';

  // ── Word count (20 points) ───────────────────────────────
  if (wordCount >= 600) {
    score += 20;
  } else if (wordCount >= 400) {
    score += 10;
    reasons.push(`Word count low (${wordCount}/600)`);
  } else {
    reasons.push(`Word count too short (${wordCount}/400 minimum)`);
  }

  // ── Sentence variety (10 points) ─────────────────────────
  // Flags AI padding: posts where >60% of sentences are under 12 words
  if (sentences.length > 0) {
    const shortSentences = sentences.filter(
      s => s.trim().split(/\s+/).length < 12
    ).length;
    const shortRatio = shortSentences / sentences.length;
    if (shortRatio < 0.6) {
      score += 10;
    } else {
      reasons.push(`Too many short sentences (${Math.round(shortRatio * 100)}% under 12 words — likely AI padding)`);
    }
  }

  // ── Contains live market data (10 points) ─────────────────
  // Checks for price patterns like $45,230 or $0.0023
  const hasPriceData = /\$[\d,]+(\.\d+)?/.test(plainText);
  if (hasPriceData) {
    score += 10;
  } else {
    reasons.push('No live price data found in content');
  }

  // ── Meta title length 50-60 chars (10 points) ────────────
  const metaTitleLen = post.meta_title?.length || 0;
  if (metaTitleLen >= 50 && metaTitleLen <= 60) {
    score += 10;
  } else {
    reasons.push(`Meta title length off (${metaTitleLen} chars, need 50-60)`);
  }

  // ── Meta description length 120-160 chars (10 points) ────
  const metaDescLen = post.meta_description?.length || 0;
  if (metaDescLen >= 120 && metaDescLen <= 160) {
    score += 10;
  } else {
    reasons.push(`Meta description length off (${metaDescLen} chars, need 120-160)`);
  }

  // ── Focus keyword in title (10 points) ───────────────────
  if (keyword && post.title?.toLowerCase().includes(keyword)) {
    score += 10;
  } else {
    reasons.push(`Focus keyword "${keyword}" missing from title`);
  }

  // ── Keyword density 0.5-2.5% (10 points) ─────────────────
  if (keyword && plainText) {
    const kwMatches = (
      plainText.toLowerCase().match(
        new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      ) || []
    ).length;
    const density = (kwMatches / wordCount) * 100;
    if (density >= 0.5 && density <= 2.5) {
      score += 10;
    } else {
      reasons.push(`Keyword density off (${density.toFixed(1)}% — aim 0.5-2.5%)`);
    }
  }

  // ── H2 headings present (5 points) ───────────────────────
  const h2Count = (post.content?.match(/<h2>/g) || []).length;
  if (h2Count >= 3) {
    score += 5;
  } else {
    reasons.push(`Not enough H2 headings (${h2Count}/3)`);
  }

  // ── Sufficient tags (5 points) ───────────────────────────
  if (post.tags && post.tags.length >= 3) {
    score += 5;
  } else {
    reasons.push('Not enough tags (need 3+)');
  }

  const passes = score >= 70;
  return { passes, score, reasons };
}

// ── AI Prompt ────────────────────────────────────────────────
function buildPrompt(
  msg: NormalizedMessage,
  category: string,
  coinContext: string,
): string {
  return `
You are a professional crypto journalist writing an original, insight-driven blog post.

SOURCE MESSAGE:
"${msg.text}"

SOURCE CHANNEL: ${msg.author}
CATEGORY: ${category}
URLS FOUND: ${msg.urls.join(', ') || 'none'}
HASHTAGS: ${msg.hashtags.join(', ') || 'none'}

LIVE MARKET DATA (use these exact figures in your content — this is what makes the post original):
${coinContext}

STRICT CONTENT REQUIREMENTS:
- Minimum 650 words of actual readable text — count carefully
- You MUST reference the live market data above with specific prices and percentages
- Each H2 section needs at least 2 full paragraphs (not padding — real analysis)
- Use proper HTML: <h2>, <p>, <ul>, <li> tags only
- Include exactly 5 H2 sections:
    1. What happened (the event/signal/news)
    2. Market context (use the live price data here)
    3. What the data suggests (your analysis — take a position)
    4. What traders and investors should watch
    5. Key takeaways
- Vary your sentence length — mix short punchy sentences with longer analytical ones
- Do NOT use filler phrases like "this could have significant implications" or "it remains to be seen"
- Take a clear analytical stance — agree or disagree with the signal, explain why
- End with: <p><em>Disclaimer: This content is for informational purposes only and does not constitute financial advice.</em></p>
- Tone: sharp, informed, direct — like a Bloomberg crypto desk piece

STRICT SEO REQUIREMENTS:
- focus_keyword: maximum 3 words (e.g. "Bitcoin price drop"). Never a full sentence.
- title: must contain the focus_keyword exactly, 60-80 total characters
- meta_title: must contain focus_keyword, BETWEEN 50 AND 60 chars exactly
- meta_description: must contain focus_keyword, BETWEEN 120 AND 160 chars exactly
- Use the focus_keyword 5-7 times naturally — never forced
- tags: exactly 5 specific crypto tags e.g. ["bitcoin", "crypto-news", "defi", "trading", "blockchain"]

RESPOND WITH VALID JSON ONLY. No markdown, no backticks, no extra text:
{
  "title": "60-80 char title with focus keyword",
  "content": "<h2>...</h2><p>...</p>... minimum 650 words with live price data woven in",
  "excerpt": "150-200 char summary with focus keyword and a specific data point",
  "meta_title": "50-60 chars exactly with focus keyword",
  "meta_description": "120-160 chars exactly with focus keyword",
  "focus_keyword": "max 3 words",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
}
`.trim();
}

// ── Publishing decision ───────────────────────────────────────
function shouldPublish(source: string, score: number): boolean {
  // Own channel: publish at 70+, external: 75+
  return source === 'bot' ? score >= 70 : score >= 75;
}

// ── Main worker ──────────────────────────────────────────────
export const aiEnrichWorker = new Worker(
  'ingest_message',
  async (job: Job) => {
    const msg: NormalizedMessage = job.data;
    const category = classifyCategory(msg.text);

    console.log(`[aiWorker] 🤖 Enriching message from ${msg.author} (source: ${msg.source})...`);

    // ── Fetch live market data before building the prompt ────
    const coinIds = detectCoins(msg.text);
    const coinData = await fetchCoinData(coinIds);
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
              'You are a professional crypto journalist. You write original, data-driven posts of at least 650 words. You always embed live market data into your analysis. You always respond with valid JSON only.',
          },
          {
            role: 'user',
            content: buildPrompt(msg, category, coinContext),
          },
        ],
        temperature: 0.65,
        max_tokens: 4000,
      });

      const raw = response.choices[0].message.content || '';
      const clean = raw.replace(/```json|```/g, '').trim();
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

      console.log('[aiWorker] ✅ AI generated post:', {
        title:         post.title,
        slug:          post.slug,
        category:      post.category,
        tags:          post.tags,
        focus_keyword: post.focus_keyword,
        word_count:    post.content?.replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean).length,
        has_price_data: /\$[\d,]+(\.\d+)?/.test(post.content || ''),
      });
    } catch (err) {
      // ── Fallback if AI fails ─────────────────────────────
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

    // ── Quality gate + publishing decision ───────────────────
    const quality = checkQuality(post);
    const publish = shouldPublish(msg.source, quality.score);
    post.is_published = publish;

    const sourceLabel = msg.source === 'bot' ? 'bot (threshold: 70)' : 'userbot (threshold: 75)';
    const publishLabel = publish ? '✅ Auto-publishing' : '📝 Saving as draft (no Telegram notify)';

    console.log(
      `[aiWorker] 📊 Quality score: ${quality.score}/100 | Source: ${sourceLabel} | ${publishLabel}`,
    );

    if (!publish) {
      console.log('[aiWorker] ⚠️ Quality issues:', quality.reasons);
    }

    // ── Route to correct queue ────────────────────────────────
    // Drafts go to draft_post queue — notifier only listens to store_post
    // so drafts will never trigger a Telegram notification
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