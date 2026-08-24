// One-off backfill: rewrites /posts/{slug} -> /blog/{slug} in already-
// stored post content and JSON-LD, left over from before the frontend
// route was known to be /blog/:slug rather than /posts/:slug.
//
// Dry-run by default — prints every row that would change and a
// before/after snippet, but writes nothing. Pass --apply to persist.
//
// Usage:
//   npx tsx scripts/backfillBlogLinks.ts            (dry run)
//   npx tsx scripts/backfillBlogLinks.ts --apply     (writes changes)

import { supabase } from '../src/supabase/client';

const APPLY = process.argv.includes('--apply');

function fixLinks(text: string): string {
  return text.replace(/\/posts\//g, '/blog/');
}

function snippetAround(text: string, needle: string, pad = 40): string {
  const i = text.indexOf(needle);
  if (i === -1) return '';
  const start = Math.max(0, i - pad);
  const end = Math.min(text.length, i + needle.length + pad);
  return `…${text.slice(start, end)}…`;
}

async function main() {
  const { data: rows, error } = await supabase
    .from('posts')
    .select('id, title, slug, content, schema_json_ld')
    .or('content.ilike.%/posts/%,schema_json_ld.ilike.%/posts/%');

  if (error) {
    console.error('[backfill] Query failed:', error.message);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    console.log('[backfill] No rows contain /posts/ — nothing to do.');
    return;
  }

  console.log(`[backfill] Found ${rows.length} row(s) with /posts/ links.\n`);

  let changed = 0;

  for (const row of rows) {
    const content = row.content || '';
    const schemaJsonLd = row.schema_json_ld || '';

    const newContent = fixLinks(content);
    const newSchema = fixLinks(schemaJsonLd);

    const contentChanged = newContent !== content;
    const schemaChanged = newSchema !== schemaJsonLd;

    if (!contentChanged && !schemaChanged) continue;
    changed++;

    console.log(`— "${row.title}" (${row.slug}, id: ${row.id})`);
    if (contentChanged) {
      console.log(`  content:      ${snippetAround(content, '/posts/')}`);
      console.log(`             -> ${snippetAround(newContent, '/blog/')}`);
    }
    if (schemaChanged) {
      console.log(`  schema_json_ld: ${snippetAround(schemaJsonLd, '/posts/')}`);
      console.log(`               -> ${snippetAround(newSchema, '/blog/')}`);
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
