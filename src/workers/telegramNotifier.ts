import { Worker, Job } from 'bullmq';
import { redisConnection } from '../queue/queues';
import { Post } from '../supabase/client';
import {
  escapeHtml,
  escapeAttr,
  stripMarkdown,
  mdLinksToHtml,
  normKey,
  dedupeBlocks,
  removeLinesCoveredBy,
  truncate,
  cleanSourceText,
} from '../utils/textClean';

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN!;
const NOTIFY_CHANNEL = process.env.TELEGRAM_NOTIFY_CHANNEL!;

const TELEGRAM_LIMIT = 4096;

// Low-level sender. Expects text that is already valid Telegram HTML.
export async function sendToChannel(text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:                  NOTIFY_CHANNEL,
      text,
      parse_mode:               'HTML',
      disable_web_page_preview: false,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
}

// ─────────────────────────────────────────────────────────────
// QUICK UPDATES
// Used by aiEnrichWorker for messages that don't warrant a full
// article (ETF flow tables, price tickers, short news). Handles
// cleaning, de-duplication, HTML escaping and formatting in one
// place so the output never repeats itself.
// ─────────────────────────────────────────────────────────────
const QUICK_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const QUICK_MAX    = 500;
const recentQuick  = new Map<string, number>();

function seenRecently(key: string): boolean {
  if (!key) return true; // nothing meaningful to send

  const now = Date.now();

  if (recentQuick.size > QUICK_MAX) {
    for (const [k, ts] of recentQuick) {
      if (now - ts > QUICK_TTL_MS) recentQuick.delete(k);
    }
    if (recentQuick.size > QUICK_MAX) recentQuick.clear();
  }

  const ts = recentQuick.get(key);
  if (ts && now - ts < QUICK_TTL_MS) return true;

  recentQuick.set(key, now);
  return false;
}

// Prefers a sentence with a number or ticker, otherwise the first sentence.
function pickHeadlineSentence(text: string): string {
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 20);

  const hot = sentences.find(s => /\$[\d,]|[\d.]+%|btc|eth|sol|xrp|bnb/i.test(s));
  return hot || sentences[0] || text;
}

export function formatQuickUpdate(rawText: string): string | null {
  const cleaned = cleanSourceText(rawText.replace(/@\w+/g, ''));
  if (!cleaned) return null;

  let headline: string;
  let rest: string;

  const lines = cleaned.split('\n');
  const first = lines[0].trim();

  if (first.length >= 8 && first.length <= 160) {
    // Structured post (title line, then details): the first line is the headline
    headline = first;
    rest     = lines.slice(1).join('\n').trim();
  } else {
    // Prose: pick the most informative sentence, and remove it from the body
    const sentence = pickHeadlineSentence(cleaned);
    headline = truncate(sentence, 160);
    rest     = cleaned.replace(sentence, '').trim();
  }

  headline = stripMarkdown(headline).replace(/\s+/g, ' ').trim();
  rest     = removeLinesCoveredBy(rest, normKey(headline));
  rest     = truncate(rest, 1500);

  const parts: string[] = [`<b>${escapeHtml(headline)}</b>`];
  if (rest) parts.push('', mdLinksToHtml(escapeHtml(rest)));
  parts.push('', '@cryptomoney');

  return parts.join('\n').slice(0, TELEGRAM_LIMIT);
}

export async function sendQuickUpdate(rawText: string): Promise<void> {
  const key = normKey(cleanSourceText(rawText)).slice(0, 200);

  if (seenRecently(key)) {
    console.log('[notifier] 🔁 Quick update already sent recently — skipping');
    return;
  }

  const message = formatQuickUpdate(rawText);
  if (!message) return;

  try {
    await sendToChannel(message);
  } catch (err) {
    recentQuick.delete(key); // let a retry through if Telegram rejected it
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// FULL-ARTICLE NOTIFICATIONS
// ─────────────────────────────────────────────────────────────

// Extract 2-3 key sentences from Markdown content, skipping anything
// that is already shown in the title or excerpt.
function extractKeyPoints(content: string, alreadyShownKeys: string[]): string[] {
  const plain = stripMarkdown(dedupeBlocks(content))
    .replace(/\s+/g, ' ')
    .trim();

  const seen = new Set<string>();

  return plain
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.length > 40 && s.length < 180)
    .filter(s => !s.toLowerCase().includes('disclaimer'))
    .filter(s => {
      const key = normKey(s);
      if (!key || seen.has(key)) return false;
      if (alreadyShownKeys.some(k => k && (k.includes(key) || key.includes(k)))) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}

function buildHashtags(tags?: string[]): string {
  if (!tags?.length) return '';
  const unique = [...new Set(
    tags
      .map(t => t.replace(/[^\p{L}\p{N}_]+/gu, ''))
      .filter(Boolean)
      .map(t => t.toLowerCase()),
  )];
  return unique.slice(0, 5).map(t => `#${t}`).join(' ');
}

function buildMessage(opts: {
  categoryLabel: string;
  title: string;
  excerpt: string;
  bullets: string[];
  postUrl: string;
  hashtags: string;
}): string {
  const { categoryLabel, title, excerpt, bullets, postUrl, hashtags } = opts;

  const parts: string[] = [`<b>${categoryLabel}</b>`, '', `<b>${escapeHtml(title)}</b>`];

  if (excerpt) parts.push('', escapeHtml(excerpt));
  if (bullets.length) {
    parts.push('', bullets.map(p => `— ${escapeHtml(p)}`).join('\n'));
  }

  parts.push('', `<a href="${escapeAttr(postUrl)}">Read the full article</a>`);
  if (hashtags) parts.push('', escapeHtml(hashtags));
  parts.push('', '@cryptomoney');

  return parts.join('\n');
}

// ─────────────────────────────────────────────────────────────
// TELEGRAM NOTIFIER WORKER
//
// Listens to `notify_post`. Flow is strictly sequential:
//   store_post → storeWorker → insertPost → notifyQueue → here
//
// By the time a job arrives here, the post is already in the DB
// and post.slug is the resolved slug that was actually saved.
// ─────────────────────────────────────────────────────────────
export const telegramNotifier = new Worker(
  'notify_post',
  async (job: Job) => {
    const post: Post = job.data;

    // Secondary guard — defensive check in case routing changes
    if (!post.is_published) {
      console.warn(
        `[notifier] ⚠️ Draft reached notify_post queue unexpectedly — skipping: "${post.title}"`,
      );
      return;
    }

    const siteUrl = (process.env.SITE_URL || 'https://cryptomonieid.com').replace(/\/$/, '');
    const postUrl = `${siteUrl}/blog/${post.slug}`;

    const categoryLabel =
      post.category === 'airdrop' ? 'Airdrop Alert'  :
      post.category === 'signal'  ? 'Trading Signal' :
      'Crypto News';

    const title = truncate(
      stripMarkdown(post.title || '').replace(/\s+/g, ' ').trim(),
      200,
    );
    const titleKey = normKey(title);

    let excerpt = dedupeBlocks(stripMarkdown(post.excerpt || ''));
    excerpt = removeLinesCoveredBy(excerpt, titleKey);
    excerpt = truncate(excerpt, 500);
    const excerptKey = normKey(excerpt);

    const keyPoints = extractKeyPoints(post.content || '', [titleKey, excerptKey]);
    const hashtags  = buildHashtags(post.tags);

    let message = buildMessage({ categoryLabel, title, excerpt, bullets: keyPoints, postUrl, hashtags });

    // Stay under Telegram's 4096 limit: drop bullets first, then shrink excerpt
    if (message.length > TELEGRAM_LIMIT) {
      message = buildMessage({ categoryLabel, title, excerpt, bullets: [], postUrl, hashtags });
    }
    if (message.length > TELEGRAM_LIMIT) {
      message = buildMessage({
        categoryLabel, title, excerpt: truncate(excerpt, 300), bullets: [], postUrl, hashtags,
      });
    }

    await sendToChannel(message);
    console.log(`[notifier] ✅ Posted to Telegram: "${title}" → ${postUrl}`);
  },
  { connection: redisConnection },
);

telegramNotifier.on('completed', job => {
  console.log(`[notifier] ✅ Job ${job.id} notified`);
});

telegramNotifier.on('failed', (job, err) => {
  console.error(`[notifier] ❌ Notification failed:`, err.message);
});