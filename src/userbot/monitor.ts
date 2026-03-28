import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import { NormalizedMessage } from '../types/message';
import dotenv from 'dotenv';

dotenv.config();

// ── Channels to monitor (add/remove as needed) ──────────────
const CHANNELS_TO_MONITOR = [
  'https://t.me/trading',
  'https://t.me/Spoilersignalsnews',
  // Add more external channel usernames here
];

function extractUrls(text: string): string[] {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) || [];
}

function extractHashtags(text: string): string[] {
  const tagRegex = /#(\w+)/g;
  const matches = [...text.matchAll(tagRegex)];
  return matches.map(m => m[1].toLowerCase());
}

export async function startUserbot(): Promise<void> {
  const apiId = parseInt(process.env.TELEGRAM_API_ID!);
  const apiHash = process.env.TELEGRAM_API_HASH!;
  const session = new StringSession(process.env.TELEGRAM_SESSION || '');

  if (!process.env.TELEGRAM_SESSION) {
    console.warn('[userbot] No TELEGRAM_SESSION in .env — run auth.ts first');
    return;
  }

  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.connect();
  console.log('[userbot] ✅ Connected to Telegram');

  // Listen to new messages from monitored channels only
  client.addEventHandler(async (event) => {
    const message = event.message;
    if (!message?.text) return;

    const chat = await message.getChat();
    const chatUsername = (chat as any)?.username || '';
    const chatTitle = (chat as any)?.title || chatUsername || 'unknown';

    // Only process messages from channels we're monitoring
    const isMonitored = CHANNELS_TO_MONITOR.some(c =>
      c.includes(chatUsername)
    );

    if (!isMonitored) return;

    const normalized: NormalizedMessage = {
      source: 'userbot',
      text: message.text,
      author: chatTitle,
      timestamp: new Date(message.date * 1000).toISOString(),
      urls: extractUrls(message.text),
      hashtags: extractHashtags(message.text),
      raw: message,
    };

    console.log('[userbot] ✅ Message received:', {
      author: normalized.author,
      preview: normalized.text.slice(0, 80),
      urls: normalized.urls.length,
      hashtags: normalized.hashtags,
    });

    // TODO: push to queue (Step 4)

  }, new NewMessage({}));

  console.log(`[userbot] Monitoring ${CHANNELS_TO_MONITOR.length} channels...`);
}