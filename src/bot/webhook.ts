import { Router, Request, Response } from 'express';
import { NormalizedMessage } from '../types/message';

export const botRouter = Router();

function extractUrls(text: string): string[] {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) || [];
}

function extractHashtags(text: string): string[] {
  const tagRegex = /#(\w+)/g;
  const matches = [...text.matchAll(tagRegex)];
  return matches.map(m => m[1].toLowerCase());
}

botRouter.post('/webhook/telegram', (req: Request, res: Response) => {
  // Validate secret token Telegram sends in header
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== process.env.TELEGRAM_SECRET_TOKEN) {
    console.warn('[bot] Unauthorized webhook call');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const update = req.body;
  const message = update.message || update.channel_post;

  // Ignore non-text updates silently
  if (!message?.text) {
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

  console.log('[bot] ✅ Message received:', {
    author: normalized.author,
    preview: normalized.text.slice(0, 80),
    urls: normalized.urls.length,
    hashtags: normalized.hashtags,
  });

  // TODO: push to queue (Step 4)

  res.status(200).json({ ok: true });
});