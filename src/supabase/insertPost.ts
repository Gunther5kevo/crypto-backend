import { supabase, Post } from './client';

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .slice(0, 80);
}

function uniqueSlug(base: string): string {
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base}-${suffix}`;
}

// ─────────────────────────────────────────────────────────────
// INSERT POST
//
// FIX: Changed return type from Promise<void> to Promise<string>.
// Returns the slug that was *actually* persisted to the DB.
//
// When a 23505 slug conflict occurs, a uniqueness suffix is
// appended (e.g. "bitcoin-etf-flows-a1b2c"). Previously the
// caller had no way to know about this, so the Telegram notifier
// always built its URL from the original slug — producing a 404
// because the DB row lived at the suffixed slug instead.
// ─────────────────────────────────────────────────────────────
export async function insertPost(post: Post): Promise<string> {
  const baseSlug = post.slug || slugify(post.title);

  const payload: Post = {
    ...post,
    slug:         baseSlug,
    is_published: post.is_published ?? false,
    views:        0,
    created_at:   new Date().toISOString(),
    updated_at:   new Date().toISOString(),
  };

  const { error } = await supabase.from('posts').insert(payload);

  if (error?.code === '23505') {
    console.warn('[insertPost] Slug conflict, retrying with unique suffix...');
    payload.slug = uniqueSlug(baseSlug);
    const { error: retryError } = await supabase.from('posts').insert(payload);
    if (retryError) throw new Error(`[insertPost] Retry failed: ${retryError.message}`);
  } else if (error) {
    throw new Error(`[insertPost] Insert failed: ${error.message}`);
  }

  console.log(
    `[insertPost] ✅ Saved: "${payload.title}" → slug: ${payload.slug} | ` +
    `published: ${payload.is_published} | ` +
    `score: ${payload.ai_quality_score ?? 'n/a'} | ` +
    `model: ${payload.model_used ?? 'unknown'}`,
  );

  // Return the slug actually written — may differ from post.slug
  // when a uniqueness suffix was appended on a 23505 retry.
  return payload.slug;
}