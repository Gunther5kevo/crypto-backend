/**
 * cleanPosts.ts — find and remove published posts that would fail AdSense review.
 *
 * Place at:  crypto-backend/src/scripts/cleanPosts.ts
 * Needs:     crypto-backend/src/workers/contentGuard.ts  (already in place)
 *
 * SAFE BY DEFAULT: a dry run changes nothing. It writes:
 *   clean-report.csv          every post, its verdict, and why
 *   clean-redirects.csv       old slug -> kept slug, for 301 redirects
 * With --apply it also writes clean-backup-<timestamp>.json (full rows) BEFORE
 * changing anything, and asks you to type "yes".
 *
 * Usage (from crypto-backend/):
 *   npx tsx src/scripts/cleanPosts.ts                       # dry run
 *   npx tsx src/scripts/cleanPosts.ts --apply               # unpublish (reversible)
 *   npx tsx src/scripts/cleanPosts.ts --apply --action delete
 *
 * Options
 *   --action unpublish|delete   default unpublish (sets is_published=false)
 *   --max N                     refuse to touch more than N posts (default 100)
 *   --include-drafts            also audit unpublished posts
 *   --no-fix-links              don't strip links to removed posts from kept posts
 *   --news-keep N               keep only the N best 'news' posts, unpublish the rest
 *   --drop-title "regex"        also remove posts whose title matches (e.g. "film hub|invoice confirmation")
 *   --no-redirects              skip writing clean-redirects.csv
 *   --strict                    also remove padded/filler posts (delete at score >= 6, not 10)
 *   --yes                       skip the confirmation prompt
 *   --file posts.json           audit an exported JSON array instead (read-only)
 */
import { promises as fs } from 'node:fs';
import * as readline from 'node:readline/promises';
import {
  findMetaLeaks, findRepeatedFigures, findPadding,
} from '../workers/contentGuard';

// ───────────────────────── types / args ─────────────────────────
interface Row {
  id: string; title: string; slug: string; content: string | null; excerpt: string | null;
  created_at: string; is_published: boolean | null; category: string | null;
  author: string | null; views: number | null; ai_quality_score: number | null;
}
type Verdict = 'DELETE' | 'REWRITE' | 'KEEP';
interface Result {
  row: Row; words: number; score: number; issues: string[]; hard: boolean;
  verdict: Verdict; redirectTo?: string; coreLeak?: boolean;
}

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const ACTION = opt('action', 'unpublish');
const MAX = Number(opt('max', '100'));

// ───────────────────────── helpers ─────────────────────────
const stripMd = (md: string) =>
  (md || '').replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^[-*]\s+/gm, '').replace(/\s+/g, ' ').trim();
const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean).length;
const normNums = (s: string) => s.toLowerCase().replace(/[\d$.,%]+[bmk]?/g, '#').replace(/[^a-z#\s]/g, ' ').replace(/\s+/g, ' ').trim();

function shingles(text: string, n = 5): Set<string> {
  const w = normNums(text).split(' ').filter(Boolean);
  const s = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(' '));
  return s;
}
function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const AI_JARGON = [
  'it is worth noting', 'it remains to be seen', 'in the ever-evolving', 'the crypto space',
  'as we know', 'needless to say', 'at the end of the day', 'in the world of crypto',
  'at the time of writing', 'game-changing', 'game changer', 'paradigm', 'groundbreaking',
  'revolutionary', 'transformative', 'pioneering', 'cutting-edge', 'holistic', 'robust',
  'synergy', 'ecosystem', 'landscape', 'navigate', 'dive into', 'delve', 'empower', 'unlock',
  'sentiment', 'significant implications', 'it is important to note',
  'this is a developing story', 'time will tell', 'only time will tell', 'interesting to see',
];
const jargonIn = (plain: string) => AI_JARGON.filter(p => {
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i').test(plain);
});


// ───────────────────────── topic scoring ─────────────────────────
// Is the STORY about crypto, or is crypto a bolted-on angle? Rules:
//  1. The TITLE must contain a crypto signal. The opening paragraph can reinforce
//     a title signal but never rescue a title that has none.
//  2. If the title has a geopolitical / macro / entertainment word, it must contain
//     a STRONG crypto term (Bitcoin, Binance, "crypto law"...). Generic "crypto"
//     in a title like "...raises risk questions for crypto markets" is not enough.
const STRONG = /\b(bitcoin|ethereum|ether|solana|xrp|ripple|cardano|dogecoin|digital assets?|stablecoins?|usdt|usdc|tether|circle|blockchain|mainnet|defi|dex|nfts?|altcoins?|memecoins?|meme coin|airdrops?|binance|coinbase|coinex|coincorner|kraken|bybit|okx|hyperliquid|polymarket|metaplanet|strive|mstr|saylor|clarity (act|bill|vote|delay|push)|genius act|etfs?|lightning|halving|staking|on-?chain|hardware wallet|liquid network|blockstream|ledger|trezor|zcash|chainlink|uniswap|avalanche|polygon|polkadot|arbitrum|crypto (wallets?|exchanges?|custody|regulation|legislation|policy|laws?|bans?|tax|rules|framework|licensing|scams?|hacks?|bills?|acts?|payments?|cards?|gift cards?|bank))\b/i;
const GENERIC = /\b(crypto|cryptocurrency|cryptocurrencies|digital assets?|tokens?|tokenized|tokenization|web3|coins?)\b/i;
const TICKER = /\b(BTC|ETH|SOL|XRP|ADA|DOGE|DOT|LINK|UNI|OP|ARB|NEAR|APT|SUI|INJ|FET|MATIC|MKR|GRAM|RENDER|AVAX|BNB|HYPE|LBTC|AAVE)\b/;
const HOOK_HARD = /\b(iran\w*|israel\w*|gaza|hamas|houthis?|ansarallah|hormuz|strait|red sea|bab al-mandab|yemen\w*|russia\w*|putin|moscow|ukrain\w*|kyiv|kremlin|nato|brics|taiwan|north korea|south korea|saudi|aramco|opec|venezuela|maduro|xi jinping|netanyahu|zelensky|middle east|west bank|palestin\w*|macron|war|missiles?|strikes?|drones?|explosions?|shootdown|refiner\w*|refuel\w*|oil|diesel|crude|election|jury|trial|murder|death|film|movie|box office|episodes?|season|netflix|marvel|disney|messi|royal|lgbtq\+?|embassy|airport|flood\w*|fire|crash|burqa|eurovision|fertility|green card|moon|torture|knife|humanoid|cuba|power grid|border|f-15)\b/i;
const HOOK_SOFT = /\b(trump|china|chinese|tariffs?|senate|apple|iphone|samsung|nvidia|openai|anthropic|meta|google|tesla|spacex|dell|jaguar|volkswagen|fed|fomc|cpi|gdp|inflation|yields?|bonds?|jobs|rate hikes?|rate cuts?|dollar|dxy|stocks?|treasury|wealth|billionaire|elon musk|bernie sanders|reddit|nepal)\b/i;
const REACT = /\b(react|reaction|pressure|risk|watch|focus|alert|edge|jitters|mood)\b/i;
const NO_CRYPTO_TITLE = /\b(no|not a?|without)\s+(any\s+)?(crypto|coin)\b|crypto news mix-?up|no coin prices|but no crypto/i;
const NO_CRYPTO_LEAD = /\bno (direct )?(crypto|coin|token)[- ](angle|link|impact|connection|price|prices|move)\b/i;

function topicScore(row: Row, plain: string): { score: number; notes: string[]; off: boolean } {
  const t = row.title;
  const lead = plain.split(/\s+/).slice(0, 150).join(' ');
  const strongT = STRONG.test(t);
  const genericT = GENERIC.test(t) || TICKER.test(t);
  const hardH = HOOK_HARD.test(t), softH = HOOK_SOFT.test(t);
  const notes: string[] = [];
  let s = 0;

  if (strongT) { s += 3; notes.push('strong crypto term in title'); }
  else if (genericT) { s += 1; notes.push('only a generic crypto word or ticker in title'); }
  else notes.push('no crypto word in title');

  if (hardH) { s -= 3; notes.push(`non-crypto hook: ${t.match(HOOK_HARD)![0]}`); }
  else if (softH) { s -= 1; notes.push(`macro/news hook: ${t.match(HOOK_SOFT)![0]}`); }

  if (NO_CRYPTO_TITLE.test(t) || (!strongT && NO_CRYPTO_LEAD.test(lead))) { s -= 4; notes.push('says it has no crypto impact'); }

  // the opening paragraph can only reinforce a title that already has a crypto signal
  if (strongT || genericT) s += STRONG.test(lead) ? 2 : GENERIC.test(lead) ? 1 : 0;

  // "...as ETH, OP and ARB react / puts UNI and OP in focus": a coin ticker used only as a
  // reaction hook, with no crypto subject, is the old pipeline's filler template
  const tickerReaction = !strongT && TICKER.test(t) && REACT.test(t);
  if (tickerReaction) notes.push('coin ticker used only as a reaction hook');
  const off = s <= 0 || tickerReaction || (!strongT && !genericT) || ((hardH || softH) && !strongT);
  return { score: s, notes, off };
}


// Your curated posts use custom category names ("Trading", "Scam", "Safety", "Ethereum",
// "Crypto Education"...). The old pipeline only ever wrote these four lowercase ones, so
// anything else was categorised by a person and is protected from auto-delete and trimming.
const PIPELINE_CATS = new Set(['news', 'guide', 'signal', 'airdrop', '']);
const isProtected = (row: Row) => !PIPELINE_CATS.has(String(row.category ?? '').trim());

// ───────────────────────── per-post analysis ─────────────────────────
function analyse(row: Row): Omit<Result, 'verdict'> {
  const issues: string[] = [];
  let score = 0, hard = false;
  const plain = stripMd(row.content || '');
  const words = wordsOf(plain);

  if (words < 250) { issues.push(`too thin (${words} words)`); score += 5; hard = true; }

  const leaks = findMetaLeaks({
    title: row.title, excerpt: row.excerpt ?? '', content: row.content ?? '',
  });
  const coreLeak = leaks.length > 0;
  if (coreLeak) { issues.push(`leaked meta text: ${leaks.join('; ')}`); score += 5; hard = true; }

  const topic = topicScore(row, plain);
  if (topic.off) {
    issues.push(`off-topic: topic score ${topic.score} (${topic.notes.join('; ')})`);
    score += 5; hard = true;
  } else if (STRONG.test(row.title) && HOOK_HARD.test(row.title)) {
    issues.push('geopolitical hook with crypto angle bolted on'); score += 3;
  }

  const dropRe = opt('drop-title');
  if (dropRe && new RegExp(dropRe, 'i').test(row.title)) {
    issues.push(`title matches --drop-title`); score += 5; hard = true;
  }

  const figs = findRepeatedFigures(plain);
  if (figs.length) { issues.push(`repeated figures: ${figs.join(', ')}`); score += 3; }

  const pad = findPadding(plain);
  if (pad.length) { issues.push(`filler phrases: ${pad.join(', ')}`); score += Math.min(pad.length * 2, 6); }

  const jar = jargonIn(plain);
  if (jar.length) { issues.push(`AI jargon: ${jar.slice(0, 6).join(', ')}`); score += Math.min(jar.length, 5); }

  if (!/disclaimer/i.test(row.content || '')) { issues.push('no disclaimer'); score += 1; }
  if (!row.excerpt) { issues.push('no excerpt'); score += 1; }

  return { row, words, score, issues, hard, coreLeak };
}

// ───────────────────────── duplicate clusters ─────────────────────────
function markDuplicates(rs: Omit<Result, 'verdict'>[]): void {
  const tNorm = rs.map(r => normNums(r.row.title));
  const tWords = tNorm.map(t => new Set(t.split(' ').filter(Boolean)));
  const sh = rs.map(r => shingles(stripMd(r.row.content || '')));
  const parent = rs.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));

  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const tj = jaccard(tWords[i], tWords[j]);
      const sameTitle = tNorm[i] !== '' && tNorm[i] === tNorm[j];
      // body comparison only when titles are at least loosely related (speed)
      if (sameTitle || tj > 0.7 || (tj > 0.3 && jaccard(sh[i], sh[j]) > 0.6)) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, number[]>();
  rs.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));

  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    // keeper: not a hard fail first, then most views, then longest
    const keep = [...idxs].sort((a, b) => {
      const ha = rs[a].hard ? 1 : 0, hb = rs[b].hard ? 1 : 0;
      if (ha !== hb) return ha - hb;
      const va = rs[a].row.views ?? 0, vb = rs[b].row.views ?? 0;
      if (va !== vb) return vb - va;
      return rs[b].words - rs[a].words;
    })[0];
    for (const i of idxs) {
      if (i === keep) { rs[i].issues.push(`kept: best of ${idxs.length} near-duplicates`); continue; }
      rs[i].issues.push(`near-duplicate of "${rs[keep].row.title.slice(0, 55)}"`);
      rs[i].score += 6; rs[i].hard = true;
      (rs[i] as Result).redirectTo = rs[keep].hard ? undefined : rs[keep].row.slug;
    }
  }
}

const verdictOf = (r: Omit<Result, 'verdict'>): Verdict =>
  r.hard || r.score >= (flag('strict') ? 6 : 10) ? 'DELETE' : r.score >= 5 ? 'REWRITE' : 'KEEP';

// ───────────────────────── data access ─────────────────────────
const COLS = 'id,title,slug,content,excerpt,created_at,is_published,category,author,views,ai_quality_score';

async function loadRows(sb: any): Promise<Row[]> {
  const file = opt('file');
  if (file) return JSON.parse(await fs.readFile(file, 'utf8'));
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from('posts').select(COLS).order('created_at', { ascending: true }).range(from, from + 999);
    if (!flag('include-drafts')) q = q.eq('is_published', true);
    const { data, error } = await q;
    if (error) throw new Error(`load failed: ${error.message}`);
    out.push(...(data as Row[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const chunk = <T>(a: T[], n: number) =>
  Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

// ───────────────────────── main ─────────────────────────
async function main() {
  if (!['unpublish', 'delete'].includes(ACTION)) throw new Error('--action must be unpublish or delete');
  const offline = !!opt('file');
  if (offline && flag('apply')) throw new Error('--file is read-only; remove --apply');

  let sb: any = null;
  if (!offline) {
    // load .env BEFORE the supabase client module reads process.env
    const dotenvName = 'dotenv';
    await import(dotenvName).then((m: any) => (m.default ?? m).config()).catch(() => {});
    sb = (await import('../supabase/client')).supabase;
  }

  const rows = await loadRows(sb);
  if (!rows.length) throw new Error('No posts found.');

  const base = rows.map(analyse);
  markDuplicates(base);
  const results: Result[] = base.map(r => {
    let v = verdictOf(r);
    // Guides are never auto-deleted (unless thin or truly leaked): a human decides.
    if (isProtected(r.row) && v === 'DELETE' && !(r.words < 250 || (r as any).coreLeak)) {
      v = 'REWRITE';
      r.issues.push('curated category: protected from auto-delete, review manually');
    }
    return { ...(r as Result), verdict: v };
  });

  // Optional: the whole archive came from one pipeline, so trim news to the best N
  const keepN = Number(opt('news-keep', '0'));
  if (keepN > 0) {
    const pool = results
      .filter(r => r.verdict !== 'DELETE' && !isProtected(r.row))
      .sort((a, b) => a.score - b.score || (b.row.views ?? 0) - (a.row.views ?? 0) ||
        String(b.row.created_at).localeCompare(String(a.row.created_at)));
    for (const r of pool.slice(keepN)) {
      r.verdict = 'DELETE';
      r.issues.push(`trimmed: outside the best ${keepN} news posts`);
    }
  }
  results.sort((a, b) => b.score - a.score);

  const tally: Record<string, number> = {};
  results.forEach(r => (tally[r.verdict] = (tally[r.verdict] ?? 0) + 1));
  console.log(`\nAudited ${results.length} posts`);
  for (const v of ['DELETE', 'REWRITE', 'KEEP']) console.log(`  ${v.padEnd(8)} ${tally[v] ?? 0}`);
  const kept: Record<string, number> = {};
  results.filter(r => r.verdict !== 'DELETE').forEach(r => { const k = r.row.category ?? 'uncategorised'; kept[k] = (kept[k] ?? 0) + 1; });
  console.log('  Remaining by category:', Object.entries(kept).map(([k, v]) => `${k} ${v}`).join(', '));
  console.log();
  for (const r of results.filter(x => x.verdict !== 'KEEP').slice(0, 60)) {
    console.log(`[${r.verdict}] score ${r.score} | ${r.words}w | ${r.row.views ?? 0} views | ${r.row.title.slice(0, 70)}`);
    r.issues.forEach(i => console.log(`    - ${i}`));
  }
  if (results.filter(x => x.verdict !== 'KEEP').length > 60) console.log('… full list in clean-report.csv');

  await fs.writeFile('clean-report.csv', [
    'verdict,score,words,views,title,slug,issues',
    ...results.map(r => [r.verdict, r.score, r.words, r.row.views ?? 0, r.row.title, r.row.slug, r.issues.join(' | ')].map(csvCell).join(',')),
  ].join('\n'));
  const removedSlugs = new Set(results.filter(r => r.verdict === 'DELETE').map(r => r.row.slug));
  const redirects = flag('no-redirects') ? [] :
    results.filter(r => r.verdict === 'DELETE' && r.redirectTo && !removedSlugs.has(r.redirectTo));
  await fs.writeFile('clean-redirects.csv', [
    'old_path,new_path',
    ...redirects.map(r => `/blog/${r.row.slug},/blog/${r.redirectTo}`),
  ].join('\n'));
  console.log(`\nWrote clean-report.csv and clean-redirects.csv (${redirects.length} redirects)`);

  const targets = results.filter(r => r.verdict === 'DELETE');
  if (!flag('apply')) {
    console.log(`\nDRY RUN: ${targets.length} post(s) would be ${ACTION === 'delete' ? 'deleted' : 'unpublished'}. Re-run with --apply.`);
    return;
  }
  if (!targets.length) return console.log('\nNothing to do.');
  if (targets.length > MAX) throw new Error(`${targets.length} posts exceed --max ${MAX}. Review clean-report.csv, then raise --max.`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `clean-backup-${stamp}.json`;
  await fs.writeFile(backup, JSON.stringify(targets.map(t => t.row), null, 2));
  console.log(`\nBackup written: ${backup}`);

  if (!flag('yes')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question(`${ACTION.toUpperCase()} ${targets.length} post(s)? Type "yes": `);
    rl.close();
    if (a.trim().toLowerCase() !== 'yes') return console.log('Cancelled. Nothing changed.');
  }

  const ids = targets.map(t => t.row.id);
  for (const part of chunk(ids, 100)) {
    const { error } = ACTION === 'delete'
      ? await sb.from('posts').delete().in('id', part)
      : await sb.from('posts').update({ is_published: false }).in('id', part);
    if (error) throw new Error(`${ACTION} failed: ${error.message}`);
  }
  console.log(`${ACTION === 'delete' ? 'Deleted' : 'Unpublished'} ${ids.length} post(s).`);

  // Strip internal links that now point at removed posts
  if (!flag('no-fix-links')) {
    const removed = new Set(targets.map(t => t.row.slug));
    const targetIds = new Set(ids);
    let fixed = 0;
    for (const r of results) {
      if (targetIds.has(r.row.id) || !r.row.content || r.row.is_published === false) continue;
      let changed = false;
      const next = r.row.content.replace(/\[([^\]]+)\]\(([^)]*\/blog\/([^)/?#]+))[^)]*\)/g,
        (m, text, _href, slug) => (removed.has(slug) ? ((changed = true), text) : m));
      if (changed) {
        const { error } = await sb.from('posts').update({ content: next }).eq('id', r.row.id);
        if (!error) fixed++;
      }
    }
    console.log(`Removed dead internal links from ${fixed} remaining post(s).`);
  }
  console.log('\nNext: add the 301 redirects from clean-redirects.csv to your site, and resubmit your sitemap in Search Console.');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });