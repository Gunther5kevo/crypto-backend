import { supabase, Post } from './client';

// Generates a URL-safe slug from a title
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')   // remove special chars
    .replace(/\s+/g, '-')            // spaces to hyphens
    .replace(/-+/g, '-')             // collapse multiple hyphens
    .trim()
    .slice(0, 80);                   // max 80 chars
}

// Appends a short random suffix to avoid slug collisions
function uniqueSlug(base: string): string {
  const suffix = Math.random().toString(36).slice(2, 7); // e.g. "k3x9p"
  return `${base}-${suffix}`;
}

export async function insertPost(post: Post): Promise<void> {
  // Always ensure slug is present
  const baseSlug = post.slug || slugify(post.title);

  const payload: Post = {
    ...post,
    slug: baseSlug,
    is_published: false,             // always false until manual review
    views: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from('posts').insert(payload);

  // If slug already exists, retry once with a unique suffix
  if (error?.code === '23505') {
    console.warn('[insertPost] Slug conflict, retrying with unique suffix...');
    payload.slug = uniqueSlug(baseSlug);
    const { error: retryError } = await supabase.from('posts').insert(payload);
    if (retryError) throw new Error(`[insertPost] Retry failed: ${retryError.message}`);
  } else if (error) {
    throw new Error(`[insertPost] Insert failed: ${error.message}`);
  }

  console.log(`[insertPost] ✅ Saved: "${payload.title}" → slug: ${payload.slug}`);
}