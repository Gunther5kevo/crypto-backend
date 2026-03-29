import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import { NormalizedMessage } from '../types/message';
import { ingestQueue } from '../queue/queues';
import dotenv from 'dotenv';

dotenv.config();

const CHANNELS_TO_MONITOR = [
  'https://t.me/trading',
  'https://t.me/Spoilersignalsnews',
  'https://t.me/+Va4L5HF7dtdmOWE0',
  'https://t.me/just',
  'https://t.me/Tensor_news',
];

// ── Layer 1: In-memory deduplication ────────────────────────
const recentHashes = new Set<string>();

function isDuplicate(text: string): boolean {
  const hash = text.slice(0, 100).toLowerCase().replace(/\s+/g, '');
  if (recentHashes.has(hash)) return true;
  recentHashes.add(hash);
  if (recentHashes.size > 500) recentHashes.clear();
  return false;
}

function isSpam(text: string): boolean {
  const spamKeywords = [
    // Adult content
    'bedroom', 'tape', 'couples', 'naked', 'xxx',
    'onlyfans', 'escort', 'adult', 'sweaty', 'nude',
    'hardcore', 'cam', 'curvy', 'riding', '4k girls',
    // Spam patterns
    'click here', 'earn $', 'make money fast',
    'dm me', 'inbox me', 'whatsapp me',
  ];
  const lower = text.toLowerCase();
  return spamKeywords.some(keyword => lower.includes(keyword));
}

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

  client.addEventHandler(async (event) => {
    const message = event.message;
    if (!message?.text) return;

    const chat = await message.getChat();
    const chatUsername = (chat as any)?.username || '';
    const chatTitle = (chat as any)?.title || chatUsername || 'unknown';

    // Only process monitored channels
    const isMonitored = CHANNELS_TO_MONITOR.some(c =>
      c.includes(chatUsername)
    );
    if (!isMonitored) return;

    // Spam filter
    if (isSpam(message.text)) {
      console.log('[userbot] 🚫 Spam filtered:', message.text.slice(0, 50));
      return;
    }

    // Duplicate filter
    if (isDuplicate(message.text)) {
      console.log('[userbot] ⚠️ Duplicate skipped:', message.text.slice(0, 50));
      return;
    }

    const normalized: NormalizedMessage = {
      source: 'userbot',
      text: message.text,
      author: chatTitle,
      timestamp: new Date(message.date * 1000).toISOString(),
      urls: extractUrls(message.text),
      hashtags: extractHashtags(message.text),
      raw: message,
    };

    // Push to ingest queue
    await ingestQueue.add('userbot_message', normalized);
    console.log('[userbot] ✅ Queued:', normalized.author, '→', normalized.text.slice(0, 60));

  }, new NewMessage({}));

  console.log(`[userbot] Monitoring ${CHANNELS_TO_MONITOR.length} channels...`);
}