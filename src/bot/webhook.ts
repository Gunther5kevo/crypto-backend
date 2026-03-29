import { Router, Request, Response } from 'express';
import { NormalizedMessage } from '../types/message';
import { ingestQueue } from '../queue/queues';

export const botRouter = Router();

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
    'bedroom', 'tape', 'couples', 'naked', 'xxx',
    'onlyfans', 'escort', 'adult', 'sweaty', 'nude',
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

botRouter.post('/webhook/telegram', async (req: Request, res: Response) => {
  // Validate secret token
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== process.env.TELEGRAM_SECRET_TOKEN) {
    console.warn('[bot] Unauthorized webhook call');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const update = req.body;
  const message = update.message || update.channel_post;

  // Ignore non-text updates
  if (!message?.text) {
    return res.status(200).json({ ok: true });
  }

  // Spam filter
  if (isSpam(message.text)) {
    console.log('[bot] 🚫 Spam filtered:', message.text.slice(0, 50));
    return res.status(200).json({ ok: true });
  }

  // Duplicate filter
  if (isDuplicate(message.text)) {
    console.log('[bot] ⚠️ Duplicate skipped:', message.text.slice(0, 50));
    return res.status(200).json({ ok: true });
  }

  const normalized: NormalizedMessage = {
    source: 'bot',
    text: message.text,
    author: message.chat?.title || message.from?.username || 'unknown',
    timestamp: new Date(message.date * 1000).toISOString(),
    urls: extractUrls(message.text),
    hashtags: extractHashtags(message.text),
    raw: message,
  };

  // Push to ingest queue
  await ingestQueue.add('bot_message', normalized);
  console.log('[bot] ✅ Queued:', normalized.author, '→', normalized.text.slice(0, 60));

  res.status(200).json({ ok: true });
});