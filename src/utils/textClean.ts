// Shared text helpers used by the userbot (ingest side), the AI enrich
// worker, and the Telegram notifier (output side).

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// Removes **bold** / __bold__ / `code` markers but keeps links and line breaks.
export function stripEmphasis(s: string): string {
  return s
    .replace(/`{1,3}/g, '')
    .replace(/\*+/g, '')
    .replace(/__/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Full Markdown strip (links become their label, headers lose their #).
export function stripMarkdown(s: string): string {
  return stripEmphasis(
    s
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, ''),
  );
}

// Turns [label](https://url) into <a href="url">label</a>.
// Call this on text that has ALREADY been passed through escapeHtml.
export function mdLinksToHtml(escapedText: string): string {
  return escapedText.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s"]+)\)/g,
    '<a href="$2">$1</a>',
  );
}

// Comparison key: lowercase letters/digits only, so
// "**ETF Flows : 27 Oct**" and "📊 ETF Flows : 27 Oct" match.
export function normKey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// Removes repeated blocks (split on blank lines). Also drops emoji-only
// blocks and truncated copies of a block that already exists.
export function dedupeBlocks(text: string): string {
  const blocks = text
    .split(/\n\s*\n/)
    .map(b => b.trim())
    .filter(Boolean);

  const kept: { raw: string; key: string }[] = [];

  for (const raw of blocks) {
    const key = normKey(raw);
    if (!key) continue;                                   // emoji-only block
    if (kept.some(k => k.key.includes(key))) continue;    // duplicate / truncated copy

    // New block is a longer version of earlier ones → replace them
    for (let i = kept.length - 1; i >= 0; i--) {
      if (key.includes(kept[i].key)) kept.splice(i, 1);
    }
    kept.push({ raw, key });
  }

  return kept.map(k => k.raw).join('\n\n');
}

// Drops any line whose content is already covered by `coveredKey`
// (e.g. an excerpt that starts by repeating the title).
export function removeLinesCoveredBy(text: string, coveredKey: string): string {
  if (!coveredKey) return text;
  return text
    .split('\n')
    .filter(line => {
      const k = normKey(line);
      return !k || !coveredKey.includes(k);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Cuts at a natural boundary (line break or space) and adds an ellipsis.
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return (boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd() + '…';
}

// Used on raw channel messages before they enter the pipeline.
export function cleanSourceText(text: string): string {
  return dedupeBlocks(stripEmphasis(text));
}