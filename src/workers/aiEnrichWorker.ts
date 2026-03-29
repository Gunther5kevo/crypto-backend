import { Worker, Job } from 'bullmq';
import OpenAI from 'openai';
import { redisConnection, storeQueue } from '../queue/queues';
import { NormalizedMessage } from '../types/message';
import { Post, ReferralLink } from '../supabase/client';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Category classifier ──────────────────────────────────────
function classifyCategory(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('airdrop') || lower.includes('claim') || lower.includes('free token'))
    return 'airdrop';
  if (lower.includes('signal') || lower.includes('buy') || lower.includes('sell') ||
      lower.includes('long') || lower.includes('short') || lower.includes('entry') ||
      lower.includes('tp') || lower.includes('sl'))
    return 'signal';
  return 'news';
}

// ── Slug generator ───────────────────────────────────────────
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .slice(0, 80);
}

// ── Referral links ───────────────────────────────────────────
function buildReferralLinks(urls: string[]): ReferralLink[] {
  return urls.map(url => {
    let type: ReferralLink['type'] = 'external';
    if (url.includes('airdrop') || url.includes('claim')) type = 'airdrop';
    else if (url.includes('ref=') || url.includes('referral')) type = 'referral';
    return { url, type };
  });
}

// ── The AI prompt — matches your existing post format exactly ─
function buildPrompt(msg: NormalizedMessage, category: string): string {
  return `
You are a professional crypto content writer. Write a complete, SEO-optimized blog post based on this Telegram message.

SOURCE MESSAGE:
"${msg.text}"

SOURCE CHANNEL: ${msg.author}
CATEGORY: ${category}
URLS FOUND: ${msg.urls.join(', ') || 'none'}
HASHTAGS: ${msg.hashtags.join(', ') || 'none'}

REQUIREMENTS:
- Write a full blog post of 400–600 words minimum
- Use proper HTML formatting exactly like this structure:
  <h2>Section Title</h2>
  <p>Paragraph text here.</p>
  <h2>Another Section</h2>
  <p>More content.</p>
- Include at least 3 H2 sections
- End with a disclaimer paragraph: <p><em>Disclaimer: This content is for informational purposes only and does not constitute financial advice.</em></p>
- Tone: professional, informative, engaging
- Focus on value for crypto investors and traders in Kenya and Africa

RESPOND WITH VALID JSON ONLY. No markdown, no backticks. Exactly this shape:
{
  "title": "Clear, compelling headline under 80 chars",
  "content": "<h2>...</h2><p>...</p>... full HTML blog post",
  "excerpt": "One sentence summary under 200 chars",
  "meta_title": "SEO title 50-60 chars with focus keyword",
  "meta_description": "SEO description 120-160 chars summarizing the post",
  "focus_keyword": "main keyword phrase e.g. Bitcoin Airdrop 2025",
  "tags": ["tag1", "tag2", "tag3"]
}
`.trim();
}

// ── Main worker ──────────────────────────────────────────────
export const aiEnrichWorker = new Worker(
  'ingest_message',
  async (job: Job) => {
    const msg: NormalizedMessage = job.data;
    const category = classifyCategory(msg.text);

    console.log(`[aiWorker] 🤖 Enriching message from ${msg.author}...`);

    let post: Post;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: buildPrompt(msg, category) }],
        temperature: 0.7,
        max_tokens: 2000,
      });

      const raw = response.choices[0].message.content || '';

      // Strip any accidental markdown fences
      const clean = raw.replace(/```json|```/g, '').trim();
      const generated = JSON.parse(clean);

      post = {
        title:            generated.title,
        slug:             slugify(generated.title),
        content:          generated.content,
        excerpt:          generated.excerpt,
        author:           msg.author,
        tags:             generated.tags || [category],
        category,
        referral_links:   buildReferralLinks(msg.urls),
        is_published:     false,
        meta_title:       generated.meta_title,
        meta_description: generated.meta_description,
        focus_keyword:    generated.focus_keyword,
      };

      console.log('[aiWorker] ✅ AI generated post:', {
        title:         post.title,
        slug:          post.slug,
        category:      post.category,
        tags:          post.tags,
        focus_keyword: post.focus_keyword,
        word_count:    post.content?.split(' ').length,
      });

    } catch (err) {
      // Fallback: save raw message if AI fails
      console.error('[aiWorker] ⚠️ AI failed, using fallback:', err);
      const title = msg.text.split(/[.\n]/)[0].slice(0, 80);
      post = {
        title,
        slug:             slugify(title),
        content:          `<p>${msg.text}</p>`,
        excerpt:          msg.text.slice(0, 200),
        author:           msg.author,
        tags:             msg.hashtags.length ? msg.hashtags : [category],
        category,
        referral_links:   buildReferralLinks(msg.urls),
        is_published:     false,
        meta_title:       title.slice(0, 60),
        meta_description: msg.text.slice(0, 155),
        focus_keyword:    msg.hashtags[0] || category,
      };
    }

    // Push to store queue
    await storeQueue.add('store_post', post);
    console.log(`[aiWorker] 📤 Pushed to store queue: ${post.slug}`);
  },
  { connection: redisConnection }
);

aiEnrichWorker.on('completed', job => {
  console.log(`[aiWorker] ✅ Job ${job.id} completed`);
});

aiEnrichWorker.on('failed', (job, err) => {
  console.error(`[aiWorker] ❌ Job ${job?.id} failed:`, err.message);
});