import { Worker, Job } from 'bullmq';
import { redisConnection } from '../queue/queues';
import { Post } from '../supabase/client';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const NOTIFY_CHANNEL = process.env.TELEGRAM_NOTIFY_CHANNEL!;

async function sendToChannel(text: string): Promise<void> {
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
  // Strip HTML tags and get plain text
  const plain = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // Split into sentences
  const sentences = plain
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.length > 40 && s.length < 180)
    .filter(s => !s.toLowerCase().includes('disclaimer'));

  // Return first 3 meaningful sentences as bullet points
  return sentences.slice(0, 3);
}

export const telegramNotifier = new Worker(
  'store_post',
  async (job: Job) => {
    const post: Post = job.data;

    // Only notify for published posts
    if (!post.is_published) {
      console.log(`[notifier] ⏭️ Skipping draft: "${post.title}"`);
      return;
    }

    const siteUrl = (process.env.SITE_URL || 'https://cryptomonieid.com').replace(/\/$/, '');
    const postUrl = `${siteUrl}/blog/${post.slug}`;

    const emoji = post.category === 'airdrop' ? '🪂'
                : post.category === 'signal'  ? '📊'
                : '📰';

    const categoryLabel = post.category === 'airdrop' ? 'Airdrop Alert'
                        : post.category === 'signal'  ? 'Trading Signal'
                        : 'Crypto News';

    // Extract key points from content
    const keyPoints = extractKeyPoints(post.content || '');
    const bulletPoints = keyPoints.map(p => `• ${p}`).join('\n');

    // Tags formatted as hashtags
    const hashtags = post.tags?.map(t => `#${t.replace(/\s+/g, '')}`).join(' ') || '';

    const message = [
      `${emoji} <b>${categoryLabel.toUpperCase()}</b>`,
      ``,
      `<b>${post.title}</b>`,
      ``,
      `${post.excerpt}`,
      ``,
      `<b>Key Points:</b>`,
      `${bulletPoints}`,
      ``,
      `━━━━━━━━━━━━━━`,
      `🌐 <a href="${postUrl}">Read Full Article</a>`,
      ``,
      `${hashtags}`,
    ].join('\n');

    await sendToChannel(message);
    console.log(`[notifier] ✅ Posted to Telegram channel: ${post.title}`);
  },
  { connection: redisConnection }
);

telegramNotifier.on('completed', job => {
  console.log(`[notifier] ✅ Job ${job.id} notified`);
});

telegramNotifier.on('failed', (job, err) => {
  console.error(`[notifier] ❌ Notification failed:`, err.message);
});