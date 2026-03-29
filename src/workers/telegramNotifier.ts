import { Worker, Job } from 'bullmq';
import { redisConnection } from '../queue/queues';
import { Post } from '../supabase/client';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const NOTIFY_CHANNEL = process.env.TELEGRAM_NOTIFY_CHANNEL!; // your channel username

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

export const telegramNotifier = new Worker(
  'store_post',
  async (job: Job) => {
    const post: Post = job.data;

    const siteUrl = process.env.SITE_URL || 'https://cryptomonieid.com/';
    const postUrl = `${siteUrl}/blog/${post.slug}`;

    const emoji = post.category === 'airdrop' ? '🪂'
                : post.category === 'signal'  ? '📊'
                : '📰';

    const message = [
      `${emoji} <b>${post.title}</b>`,
      ``,
      `${post.excerpt}`,
      ``,
      `🔗 <a href="${postUrl}">Read full post</a>`,
      ``,
      `🏷 ${post.tags?.map(t => `#${t}`).join(' ') || ''}`,
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