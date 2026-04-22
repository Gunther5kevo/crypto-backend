import { Worker, Job } from 'bullmq';
import { redisConnection } from '../queue/queues';
import { Post } from '../supabase/client';

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN!;
const NOTIFY_CHANNEL = process.env.TELEGRAM_NOTIFY_CHANNEL!;

// Exported so aiEnrichWorker can send quick Telegram-only alerts
// for price tickers and low-value messages that don't warrant a full post.
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

// Extract 2-3 key bullet points from HTML content
function extractKeyPoints(content: string): string[] {
  const plain = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.length > 40 && s.length < 180)
    .filter(s => !s.toLowerCase().includes('disclaimer'))
    .slice(0, 3);
}

// ─────────────────────────────────────────────────────────────
// TELEGRAM NOTIFIER WORKER
//
// FIX: Now listens to `notify_post` instead of `store_post`.
//
// Previously both this worker and storeWorker consumed the same
// store_post queue. BullMQ competing consumers meant the
// notifier could pick up a job before (or in parallel with) the
// store worker — and always used post.slug from the original
// payload, which didn't account for the uniqueness suffix that
// insertPost appends on a 23505 slug conflict.
//
// Now the flow is strictly sequential:
//   store_post → storeWorker → insertPost → notifyQueue → here
//
// By the time a job arrives here, the post is already in the DB
// and post.slug is the resolved slug that was actually saved.
// ─────────────────────────────────────────────────────────────
export const telegramNotifier = new Worker(
  'notify_post',                            // ← was 'store_post'
  async (job: Job) => {
    const post: Post = job.data;

    // Secondary guard — defensive check in case routing changes
    if (!post.is_published) {
      console.warn(
        `[notifier] ⚠️ Draft reached notify_post queue unexpectedly — skipping: "${post.title}"`,
      );
      return;
    }

    // post.slug is the resolved slug from insertPost — guaranteed
    // to match the row in the DB, no 404s.
    const siteUrl = (process.env.SITE_URL || 'https://cryptomonieid.com').replace(/\/$/, '');
    const postUrl = `${siteUrl}/posts/${post.slug}`;

    const categoryLabel =
      post.category === 'airdrop' ? 'Airdrop Alert'  :
      post.category === 'signal'  ? 'Trading Signal' :
      'Crypto News';

    const keyPoints    = extractKeyPoints(post.content || '');
    const bulletPoints = keyPoints.map(p => `— ${p}`).join('\n');
    const hashtags     = post.tags?.map(t => `#${t.replace(/\s+/g, '')}`).join(' ') || '';

    const message = [
      `<b>${categoryLabel}</b>`,
      ``,
      `<b>${post.title}</b>`,
      ``,
      post.excerpt,
      ``,
      bulletPoints,
      ``,
      `<a href="${postUrl}">Read the full article</a>`,
      ``,
      hashtags,
      ``,
      `@cryptomoney`,
    ].join('\n');

    await sendToChannel(message);
    console.log(`[notifier] ✅ Posted to Telegram: "${post.title}" → ${postUrl}`);
  },
  { connection: redisConnection },
);

telegramNotifier.on('completed', job => {
  console.log(`[notifier] ✅ Job ${job.id} notified`);
});

telegramNotifier.on('failed', (job, err) => {
  console.error(`[notifier] ❌ Notification failed:`, err.message);
});