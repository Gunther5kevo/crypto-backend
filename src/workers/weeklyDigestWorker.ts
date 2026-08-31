import { Worker } from 'bullmq';
import OpenAI from 'openai';
import { redisConnection, digestQueue } from '../queue/queues';
import { supabase } from '../supabase/client';
import { sendToChannel } from './telegramNotifier';

// ─────────────────────────────────────────────────────────────
// Weekly newsletter auto-draft.
//
// Every week this worker looks at posts published since the last run,
// asks OpenAI for a short subject + intro summarising them, and saves
// the result to newsletter_drafts (status: 'pending'). It never sends
// anything itself — the admin still reviews and hits send from
// AdminNewsletterBlast, which loads the pending draft on open.
// A Telegram ping (reusing the existing notify channel) tells the
// admin a draft is ready, mirroring how new posts are already
// announced.
// ─────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SITE_NAME = process.env.SITE_NAME ?? 'CryptoMoney';
const DIGEST_CRON = process.env.NEWSLETTER_DIGEST_CRON ?? '0 8 * * 1'; // Monday 08:00 UTC
const MAX_POSTS = 8;

interface DigestPost {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  category: string;
}

async function generateDigestCopy(
  posts: DigestPost[],
): Promise<{ subject: string; intro: string }> {
  const list = posts
    .map((p, i) => `${i + 1}. [${p.category}] ${p.title} — ${p.excerpt}`)
    .join('\n');

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      temperature: 0.6,
      max_completion_tokens: 400,
      messages: [
        {
          role: 'system',
          content:
            'You write short, plain-language weekly crypto newsletter intros. ' +
            'No AI jargon ("ecosystem", "landscape", "delve", "sentiment", etc). ' +
            'Return ONLY valid JSON, no code fences.',
        },
        {
          role: 'user',
          content:
            `Write a newsletter subject line and a 2-3 sentence intro for ${SITE_NAME}'s ` +
            `weekly briefing, based on these ${posts.length} stories published this week:\n\n${list}\n\n` +
            `Return JSON: {"subject": "...", "intro": "..."}. ` +
            `Subject under 80 characters, no clickbait, specific to the actual stories. ` +
            `Intro should read like a person wrote it, not a summary bot.`,
        },
      ],
    });

    const raw = response.choices[0].message.content ?? '';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (parsed.subject && parsed.intro) {
      return { subject: parsed.subject, intro: parsed.intro };
    }
  } catch (err) {
    console.warn('[weeklyDigest] ⚠️ AI copy generation failed, using fallback:', err);
  }

  return {
    subject: `This week on ${SITE_NAME}: ${posts.length} stories worth your time`,
    intro: `Here's what we covered this week — ${posts.length} stories across ${
      [...new Set(posts.map((p) => p.category))].join(', ')
    }.`,
  };
}

export const weeklyDigestWorker = new Worker(
  'weekly_digest',
  async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: posts, error } = await supabase
      .from('posts')
      .select('id, slug, title, excerpt, category, created_at')
      .eq('is_published', true)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(MAX_POSTS);

    if (error) {
      console.error('[weeklyDigest] Supabase fetch error:', error);
      return;
    }

    if (!posts || posts.length === 0) {
      console.log('[weeklyDigest] No posts published in the last 7 days — skipping draft.');
      return;
    }

    // Avoid piling up unreviewed drafts if last week's was never sent/dismissed.
    const { data: existingPending } = await supabase
      .from('newsletter_drafts')
      .select('id')
      .eq('status', 'pending')
      .limit(1)
      .maybeSingle();

    if (existingPending) {
      console.log('[weeklyDigest] A pending draft already exists — skipping until it is sent or dismissed.');
      return;
    }

    const { subject, intro } = await generateDigestCopy(posts as DigestPost[]);

    const { data: draft, error: insertError } = await supabase
      .from('newsletter_drafts')
      .insert({
        subject,
        body_text: intro,
        post_ids: posts.map((p) => p.id),
        status: 'pending',
      })
      .select()
      .single();

    if (insertError) {
      console.error('[weeklyDigest] Failed to save draft:', insertError);
      return;
    }

    console.log(`[weeklyDigest] ✅ Draft ready — "${subject}" (${posts.length} posts)`);

    try {
      const adminUrl = `${(process.env.FRONTEND_URL ?? '').replace(/\/$/, '')}/admin/newsletter`;
      await sendToChannel(
        `📰 <b>Weekly newsletter draft ready</b>\n"${subject}"\n${posts.length} posts attached.\nReview &amp; send: ${adminUrl}`,
      );
    } catch (err) {
      console.warn('[weeklyDigest] ⚠️ Telegram notify failed:', err);
    }

    return draft;
  },
  { connection: redisConnection },
);

weeklyDigestWorker.on('completed', (job) => {
  console.log(`[weeklyDigest] Job ${job.id} completed`);
});

weeklyDigestWorker.on('failed', (job, err) => {
  console.error(`[weeklyDigest] Job ${job?.id} failed:`, err.message);
});

// Register the recurring schedule. jobId keeps this idempotent across
// server restarts/deploys — BullMQ won't create a duplicate repeatable job.
digestQueue.add(
  'generate_weekly_digest',
  {},
  { jobId: 'weekly-digest', repeat: { pattern: DIGEST_CRON } },
).catch((err) => console.error('[weeklyDigest] Failed to schedule repeatable job:', err));
