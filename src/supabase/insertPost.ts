import { supabase, Post } from './client';

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

export async function insertPost(post: Post): Promise<void> {
  const baseSlug = post.slug || slugify(post.title);

  const payload: Post = {
    ...post,
    slug:         baseSlug,
    is_published: post.is_published ?? false,  // never null
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

  console.log(`[insertPost] ✅ Saved: "${payload.title}" → slug: ${payload.slug} | published: ${payload.is_published}`);
}
