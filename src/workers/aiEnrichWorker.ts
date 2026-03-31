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

// ── SEO Quality Gate ─────────────────────────────────────────
interface QualityResult {
  passes: boolean;
  score: number;
  reasons: string[];
}

function checkQuality(post: Post): QualityResult {
  const reasons: string[] = [];
  let score = 0;

  const plainText = post.content?.replace(/<[^>]+>/g, '') || '';
  const wordCount = plainText.split(/\s+/).filter(Boolean).length;
  const keyword = post.focus_keyword?.toLowerCase() || '';

  // ── Word count (25 points) ───────────────────────────────
  if (wordCount >= 500) {
    score += 25;
  } else if (wordCount >= 300) {
    score += 10;
    reasons.push(`Word count low (${wordCount}/500)`);
  } else {
    reasons.push(`Word count too short (${wordCount}/300)`);
  }

  // ── Meta title length 50-60 chars (15 points) ────────────
  const metaTitleLen = post.meta_title?.length || 0;
  if (metaTitleLen >= 50 && metaTitleLen <= 60) {
    score += 15;
  } else {
    reasons.push(`Meta title length off (${metaTitleLen}/60 chars)`);
  }

  // ── Meta description length 120-160 chars (15 points) ────
  const metaDescLen = post.meta_description?.length || 0;
  if (metaDescLen >= 120 && metaDescLen <= 160) {
    score += 15;
  } else {
    reasons.push(`Meta description length off (${metaDescLen}/160 chars)`);
  }

  // ── Focus keyword in title (15 points) ───────────────────
  if (keyword && post.title?.toLowerCase().includes(keyword)) {
    score += 15;
  } else {
    reasons.push(`Focus keyword "${keyword}" not in title`);
  }

  // ── Keyword density in content 0.5-3% (15 points) ────────
  if (keyword && plainText) {
    const kwMatches = (plainText.toLowerCase().match(
      new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    ) || []).length;
    const density = (kwMatches / wordCount) * 100;
    if (density >= 0.5 && density <= 3) {
      score += 15;
    } else {
      reasons.push(`Keyword density off (${density.toFixed(1)}% — aim 0.5-3%)`);
    }
  }

  // ── H2 headings present (10 points) ──────────────────────
  if (post.content?.includes('<h2>')) {
    score += 10;
  } else {
    reasons.push('No H2 headings found');
  }

  // ── Has tags (5 points) ───────────────────────────────────
  if (post.tags && post.tags.length >= 3) {
    score += 5;
  } else {
    reasons.push('Not enough tags (need 3+)');
  }

  const passes = score >= 70;
  return { passes, score, reasons };
}

// ── AI Prompt ────────────────────────────────────────────────
function buildPrompt(msg: NormalizedMessage, category: string): string {
  return `
You are a professional crypto content writer for an African audience. Write a complete SEO-optimized blog post.

SOURCE MESSAGE:
"${msg.text}"

SOURCE CHANNEL: ${msg.author}
CATEGORY: ${category}
URLS FOUND: ${msg.urls.join(', ') || 'none'}
HASHTAGS: ${msg.hashtags.join(', ') || 'none'}

STRICT CONTENT REQUIREMENTS:
- The content field MUST contain at least 600 words of actual readable text — count carefully before responding
- Each H2 section must have at least 2-3 paragraphs underneath it
- Use proper HTML: <h2>, <p>, <ul>, <li> tags only
- Include exactly 5 H2 sections covering: introduction, background, impact on Africa/Kenya, what to do, conclusion
- Write short clear sentences — max 20 words per sentence
- End content with: <p><em>Disclaimer: This content is for informational purposes only and does not constitute financial advice.</em></p>
- Tone: professional, informative, engaging
- Target audience: crypto investors and traders in Kenya and Africa

STRICT SEO REQUIREMENTS:
- focus_keyword: maximum 3 words (e.g. "Bitcoin price", "crypto signal"). Never a full sentence.
- title: must contain the focus_keyword exactly, between 60-80 total characters
- meta_title: must contain focus_keyword, count characters carefully — must be BETWEEN 50 AND 60 chars
- meta_description: must contain focus_keyword, count characters carefully — must be BETWEEN 120 AND 160 chars
- Use the focus_keyword at least 6 times naturally in the content
- tags: exactly 5 specific crypto tags

RESPOND WITH VALID JSON ONLY. No markdown, no backticks, no extra text:
{
  "title": "60-80 char title with focus keyword",
  "content": "<h2>Section 1</h2><p>paragraph...</p><p>paragraph...</p><h2>Section 2</h2><p>paragraph...</p>... minimum 600 words",
  "excerpt": "150-200 char summary with focus keyword",
  "meta_title": "50-60 chars exactly with focus keyword",
  "meta_description": "120-160 chars exactly with focus keyword",
  "focus_keyword": "max 3 words",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
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
        messages: [
          {
            role: 'system',
            content: 'You are a professional crypto content writer. You always write detailed, thorough blog posts of at least 600 words. You never write short posts. You always respond with valid JSON only.',
          },
          {
            role: 'user',
            content: buildPrompt(msg, category),
          },
        ],
        temperature: 0.7,
        max_tokens: 4000, // increased to allow full 600+ word posts
      });

      const raw = response.choices[0].message.content || '';
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
        word_count:    post.content?.replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean).length,
      });

    } catch (err) {
      // ── Fallback if AI fails ───────────────────────────────
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

    // ── Quality gate ─────────────────────────────────────────
    const quality = checkQuality(post);
    post.is_published = quality.passes;

    console.log(`[aiWorker] 📊 Quality score: ${quality.score}/100 — ${quality.passes ? '✅ Auto-publishing' : '📝 Saving as draft'}`);
    if (!quality.passes) {
      console.log(`[aiWorker] ⚠️ Quality issues:`, quality.reasons);
    }

    // ── Push to store queue ───────────────────────────────────
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