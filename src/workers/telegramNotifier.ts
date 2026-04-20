import { Worker, Job } from 'bullmq';
import { redisConnection } from '../queue/queues';
import { Post } from '../supabase/client';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const NOTIFY_CHANNEL = process.env.TELEGRAM_NOTIFY_CHANNEL!;

// Exported so aiEnrichWorker can send quick Telegram-only alerts
// for price tickers and low-value messages that don't warrant a full post.
export async function sendToChannel(text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: NOTIFY_CHANNEL,
      text,
      parse_mode: 'HTML',
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

// This worker ONLY listens to store_post — the queue that only receives
// published posts. Drafts are routed to draft_post in the AI worker,
// so they never reach here and never trigger a Telegram notification.
export const telegramNotifier = new Worker(
  'store_post',
  async (job: Job) => {
    const post: Post = job.data;

    // Secondary guard — defensive check in case queue routing ever changes
    if (!post.is_published) {
      console.warn(
        `[notifier] ⚠️ Draft reached store_post queue unexpectedly — skipping: "${post.title}"`,
      );
      return;
    }

    const siteUrl = (process.env.SITE_URL || 'https://cryptomonieid.com').replace(/\/$/, '');
    const postUrl = `${siteUrl}/blog/${post.slug}`;

    const categoryLabel =
      post.category === 'airdrop' ? 'Airdrop Alert' :
      post.category === 'signal'  ? 'Trading Signal' :
      'Crypto News';

    const keyPoints = extractKeyPoints(post.content || '');
    const bulletPoints = keyPoints.map(p => `— ${p}`).join('\n');
    const hashtags = post.tags?.map(t => `#${t.replace(/\s+/g, '')}`).join(' ') || '';

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
      `${hashtags}`,
      ``,
      `@cryptomoney`,
    ].join('\n');

    await sendToChannel(message);
    console.log(`[notifier] ✅ Posted to Telegram channel: "${post.title}"`);
  },
  { connection: redisConnection },
);

telegramNotifier.on('completed', job => {
  console.log(`[notifier] ✅ Job ${job.id} notified`);
});

telegramNotifier.on('failed', (job, err) => {
  console.error(`[notifier] ❌ Notification failed:`, err.message);
});