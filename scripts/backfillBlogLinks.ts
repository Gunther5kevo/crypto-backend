// One-off backfill for internal links that lead nowhere ("Article not
// found" / 404). Two problems, both fixed here:
//
//   1. /posts/{slug} -> /blog/{slug} — leftover from before the frontend
//      route was known to be /blog/:slug rather than /posts/:slug.
//   2. Hallucinated links — [text](/blog/{slug}) (or a stray HTML <a>)
//      pointing at a slug that isn't an actual published post, invented
//      by the AI pipeline before aiEnrichWorker.ts started sanitising
//      and capping internal links. These are stripped down to plain
//      text (link removed, anchor text kept) rather than guessed at,
//      matching the policy the live pipeline already enforces.
//
// Dry-run by default — prints every row that would change and a
// before/after snippet, but writes nothing. Pass --apply to persist.
//
// Usage:
//   npx tsx scripts/backfillBlogLinks.ts            (dry run)
//   npx tsx scripts/backfillBlogLinks.ts --apply     (writes changes)

import { supabase } from '../src/supabase/client';

const APPLY = process.argv.includes('--apply');

function fixLinks(text: string, validSlugs: Set<string>): string {
  // Step 1: route prefix fix
  let out = text.replace(/\/posts\//g, '/blog/');

  // Step 2: strip Markdown links whose /blog/{slug} isn't a real,
  // published post — keep the anchor text, drop the dead link.
  out = out.replace(
    /\[([^\]]+)\]\(([^)]*)\)/g,
    (match, anchorText, href) => {
      const internalMatch = href.match(/\/blog\/([^)/?#]+)/);
      if (!internalMatch) return match; // external link — leave alone
      return validSlugs.has(internalMatch[1]) ? match : anchorText;
    },
  );

  // Step 3: strip stray raw HTML anchors pointing at dead internal slugs
  // (legacy pre-Markdown posts stored raw HTML).
  out = out.replace(
    /<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi,
    (match, href, anchorText) => {
      const internalMatch = href.match(/\/blog\/([^"/?#]+)/);
      if (!internalMatch) return match; // external link — leave alone
      return validSlugs.has(internalMatch[1]) ? match : anchorText;
    },
  );

  return out;
}

// Finds the first point where two strings diverge and prints a snippet
// around it — works for any kind of change (prefix rewrite or a link
// being stripped down to plain text), not just a fixed needle.
function diffSnippet(before: string, after: string, pad = 40): [string, string] {
  let i = 0;
  const minLen = Math.min(before.length, after.length);
  while (i < minLen && before[i] === after[i]) i++;

  const start = Math.max(0, i - pad);
  const beforeEnd = Math.min(before.length, i + pad);
  const afterEnd = Math.min(after.length, i + pad);

  return [
    `…${before.slice(start, beforeEnd)}…`,
    `…${after.slice(start, afterEnd)}…`,
  ];
}

async function main() {
  // Build the set of slugs a link is actually allowed to point at —
  // published posts only, since that's all BlogPost.tsx will serve
  // (drafts and deleted posts render as "Article not found").
  const { data: publishedPosts, error: slugError } = await supabase
    .from('posts')
    .select('slug')
    .eq('is_published', true);

  if (slugError) {
    console.error('[backfill] Failed to load published slugs:', slugError.message);
    process.exit(1);
  }

  const validSlugs = new Set((publishedPosts ?? []).map(p => p.slug));
  console.log(`[backfill] ${validSlugs.size} published slug(s) considered valid.\n`);

  const { data: rows, error } = await supabase
    .from('posts')
    .select('id, title, slug, content, schema_json_ld')
    .or('content.ilike.%/posts/%,content.ilike.%/blog/%,schema_json_ld.ilike.%/posts/%');

  if (error) {
    console.error('[backfill] Query failed:', error.message);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    console.log('[backfill] No rows contain internal links — nothing to do.');
    return;
  }

  console.log(`[backfill] Scanning ${rows.length} row(s) with internal links.\n`);

  let changed = 0;

  for (const row of rows) {
    const content = row.content || '';
    const schemaJsonLd = row.schema_json_ld || '';

    const newContent = fixLinks(content, validSlugs);
    const newSchema = fixLinks(schemaJsonLd, validSlugs);

    const contentChanged = newContent !== content;
    const schemaChanged = newSchema !== schemaJsonLd;

    if (!contentChanged && !schemaChanged) continue;
    changed++;

    console.log(`— "${row.title}" (${row.slug}, id: ${row.id})`);
    if (contentChanged) {
      const [before, after] = diffSnippet(content, newContent);
      console.log(`  content:      ${before}`);
      console.log(`             -> ${after}`);
    }
    if (schemaChanged) {
      const [before, after] = diffSnippet(schemaJsonLd, newSchema);
      console.log(`  schema_json_ld: ${before}`);
      console.log(`               -> ${after}`);
    }

    if (APPLY) {
      const { error: updateError } = await supabase
        .from('posts')
        .update({
          content: newContent,
          schema_json_ld: newSchema,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);

      if (updateError) {
        console.error(`  ❌ Update failed: ${updateError.message}`);
      } else {
        console.log(`  ✅ Updated`);
      }
    }
    console.log('');
  }

  console.log(
    APPLY
      ? `[backfill] Done — updated ${changed} row(s).`
      : `[backfill] Dry run — ${changed} row(s) would change. Re-run with --apply to write.`,
  );
}

main();
