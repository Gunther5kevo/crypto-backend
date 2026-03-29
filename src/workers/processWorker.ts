import { Worker, Job } from 'bullmq';
import { redisConnection, storeQueue } from '../queue/queues';
import { NormalizedMessage } from '../types/message';
import { Post, ReferralLink } from '../supabase/client';

// ── Category Classification ──────────────────────────────────
function classifyCategory(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('airdrop') || lower.includes('claim') || lower.includes('free token')) {
    return 'airdrop';
  }
  if (lower.includes('signal') || lower.includes('buy') || lower.includes('sell') ||
      lower.includes('long') || lower.includes('short') || lower.includes('tp') ||
      lower.includes('sl') || lower.includes('entry')) {
    return 'signal';
  }
  return 'news';
}

// ── Title Generation ─────────────────────────────────────────
function generateTitle(text: string, author: string): string {
  // Use first sentence or first 80 chars
  const firstSentence = text.split(/[.\n!?]/)[0].trim();
  if (firstSentence.length > 10 && firstSentence.length <= 80) {
    return firstSentence;
  }
  // Fallback: author + category + date
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${author} — Crypto Update ${date}`;
}

// ── Slug Generator ───────────────────────────────────────────
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .slice(0, 80);
}

// ── Text Cleaner ─────────────────────────────────────────────
function cleanText(text: string): string {
  return text
    .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')  // remove emojis
    .replace(/(.)\1{4,}/g, '$1')              // remove excessive repeated chars
    .replace(/\n{3,}/g, '\n\n')              // collapse excess newlines
    .replace(/[ \t]+/g, ' ')                  // normalize spaces
    .trim();
}

// ── SEO Fields ───────────────────────────────────────────────
function generateMetaDescription(text: string): string {
  const clean = cleanText(text);
  return clean.slice(0, 155).trim() + (clean.length > 155 ? '...' : '');
}

function generateFocusKeyword(tags: string[], category: string): string {
  if (tags.length > 0) {
    return tags[0].charAt(0).toUpperCase() + tags[0].slice(1);
  }
  const defaults: Record<string, string> = {
    airdrop: 'Crypto Airdrop',
    signal: 'Crypto Signal',
    news: 'Crypto News',
  };
  return defaults[category] || 'Crypto';
}

// ── Referral Links Builder ───────────────────────────────────
function buildReferralLinks(urls: string[]): ReferralLink[] {
  return urls.map(url => {
    let type: ReferralLink['type'] = 'external';
    if (url.includes('airdrop') || url.includes('claim') || url.includes('free')) {
      type = 'airdrop';
    } else if (url.includes('ref=') || url.includes('referral') || url.includes('invite')) {
      type = 'referral';
    }
    return { url, type };
  });
}

// ── Main Mapper: NormalizedMessage → Post ────────────────────
function mapToPost(msg: NormalizedMessage): Post {
  const cleaned = cleanText(msg.text);
  const title = generateTitle(cleaned, msg.author);
  const slug = slugify(title);
  const category = classifyCategory(cleaned);
  const tags = msg.hashtags.length > 0
    ? msg.hashtags
    : [category, msg.author.toLowerCase().replace(/\s+/g, '-')];
  const metaDescription = generateMetaDescription(cleaned);
  const focusKeyword = generateFocusKeyword(tags, category);

  return {
    title,
    slug,
    content: cleaned,
    excerpt: cleaned.slice(0, 200).trim(),
    author: msg.author,
    tags,
    category,
    referral_links: buildReferralLinks(msg.urls),
    is_published: false,
    meta_title: title.slice(0, 60),
    meta_description: metaDescription,
    focus_keyword: focusKeyword,
  };
}

// ── Worker ───────────────────────────────────────────────────
export const processWorker = new Worker(
  'ingest_message',
  async (job: Job) => {
    const msg: NormalizedMessage = job.data;

    console.log(`[worker] 📥 Processing job ${job.id} from ${msg.author}`);

    const post = mapToPost(msg);

    console.log('[worker] ✅ Mapped to post:', {
      title: post.title,
      slug: post.slug,
      category: post.category,
      tags: post.tags,
      focus_keyword: post.focus_keyword,
    });

    // Push to store queue
    await storeQueue.add('store_post', post);
    console.log(`[worker] 📤 Pushed to store queue: ${post.slug}`);
  },
  { connection: redisConnection }
);

processWorker.on('completed', job => {
  console.log(`[worker] ✅ Job ${job.id} completed`);
});

processWorker.on('failed', (job, err) => {
  console.error(`[worker] ❌ Job ${job?.id} failed:`, err.message);
});