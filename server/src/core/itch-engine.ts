/**
 * Native itch research engine — ported from Python itch_core so Atrium owns the
 * logic with no external app spawn. Calls `eigen` (the model harness) directly.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../config.js';

const HOME = homedir();
const STATE_DIR = config.paths.itchConfig;
const RUNS_DIR = config.paths.itchRuns;
const DECISIONS_FILE = join(STATE_DIR, 'decisions.json');
const INTERESTS_FILE = join(STATE_DIR, 'interests.md');
const RULES_FILE = join(STATE_DIR, 'rules.md');
const WORK_FILE = join(STATE_DIR, 'work.txt');
const WORK_MD_FILE = join(STATE_DIR, 'work.md');

const DEFAULT_PROJECTS_DIR = process.env.ITCH_PROJECTS_DIR || join(HOME, 'projects');
const DEFAULT_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
const DECAY_TOTAL = 5;
const PURSUED_LOOKBACK = DECAY_TOTAL + 4;

const IDEA_RE = /^#{1,3}\s+[A-Za-z]*\d+\.\s*(.+?)\s*$/;
const RESURFACE_RE = /^[↻⟳]\s*/;

async function readJson<T = any>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

/** Single-pass {key} substitution — parity with Python str.format: each {key}
 * is replaced exactly once, replacement text is inserted LITERALLY (no `$&`/`$1`
 * special handling), and a value containing another {key} is NEVER re-scanned.
 * The chained String.replace(string,string) approach fails all three. */
function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole);
}

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) resolve('');
      else resolve(String(stdout));
    });
  });
}

const SYSTEM_PROMPT = `You are an outward idea scout. You are given a profile of everything a builder ALREADY does -- their recurring patterns, their local working trees, and their public GitHub repositories. Your single job: use web search to find NEW things they should consider building or exploring that they are NOT already doing.

Hard rules:
- NEW only. If it is already in the profile (or an obvious continuation of it), do not return it. The profile exists so you can exclude what they already do.
- Ship status is opaque. The profile lists projects the builder ALREADY has; nothing here tells you whether one is shipped, abandoned, or mid-build -- and a project's git state would NOT tell you either (a dirty or stale tree is often a finished, shipped project). Never propose finishing, shipping, reviving, or continuing anything listed. Only propose genuinely new directions.
- The native INTENT PROFILE section is the authoritative interest profile. Treat STATED INTERESTS and [STARRED] GitHub repos as positive taste signals. Treat authored repos, local projects, and [WORK] items as exclusion/de-dup context unless STATED INTERESTS or prior ratings explicitly promote that direction.
- Grounded + deep. Every idea must be backed by something you actually found via web search -- a recent release, paper, tool, trend, gap, or unmet need. Search DEEP, not shallow: issue several distinct queries, follow promising sources (fetch the page, don't stop at the snippet), and prefer findings from the last ~6-9 months. Cite the source URL(s). No ideas from prior knowledge alone.
- VALIDATE, never assert. Any claim that sets an idea's value -- novelty ("no tool does this", "first to X", "nothing open-source exists"), timeliness (a release/paper date or "N days old"), and the mechanism you credit a finding with -- must be CHECKED by a real search before you write it, never recalled from memory. Run prior-art and competitor queries on purpose: name the closest existing tool/paper/product you found (with a URL), or state the query that came up empty. Open the source you cite and confirm it says what you claim -- right artifact, right date, right mechanism; a tangential link is not proof. If the check kills the premise, drop the idea or re-pitch the narrower gap that survives, and say what changed. An unchecked "first"/"novel" claim is a failed idea, not a bold one.
- Fits them. Infer their demonstrated skills and interests from the profile below (stated interests, starred repos, authored repos, languages, and local projects) -- do not assume a fixed skill set. An idea they could plausibly start is worth more than an impressive one they cannot.
- Outward and wide. Prefer ideas that expose them to areas adjacent to but outside their current orbit -- new ecosystems, emerging primitives, underserved niches -- over more of what they already grind on.
- [WORK] items are the builder's day job, and the OFF-LIMITS WORK ECOSYSTEMS section lists the ecosystems that job saturates. Propose NOTHING in or adjacent to them, no matter how well they fit -- not the work projects themselves, their direct clients/servers, or their immediate ecosystem. Aim ideas at the builder's personal / independent domains.
- ALREADY SUGGESTED LAST RUN is a HARD exclusion: do not repeat or lightly reword. RECENTLY SUGGESTED (within last 5 runs) is a SOFT exclusion: skip these unless your web search has surfaced a substantially different angle on one, in which case you may return it with the title prefixed by "↻ " (a single resurface marker so the user can see it came back from the soft zone). Do not use the marker for genuinely new ideas.
- CURRENTLY PURSUING items are ones the builder rated 5 -- they are actively working on them or a direct continuation. Propose nothing that extends, follows-up on, or is adjacent to those. Prefer ideas that are deliberately orthogonal -- different domain, different stack, different problem class.
- Any list item may carry a "-- <note>" suffix: that is the builder's own reason for the rating. Treat it as a strong steer and generalize from it -- do not merely avoid the exact words. A note in CURRENTLY PURSUING tells you what axis to stay orthogonal to. The AVOID THIS FLAVOR list is drop reasons: the title itself may be re-proposed, but do not propose anything of the same flavor the note describes -- infer the category and steer wide of it.
- The EXTRA RULES section (freeform text the builder wrote in rules.md) is their explicit standing steer: honor it directly, alongside -- not above or below -- the rating-derived signals above.
- [STARRED] items are repos the builder STARRED on GitHub: a taste/interest signal (what they like), NOT something they have built. Treat them as positive taste signals -- lean toward their themes -- but do NOT exclude an idea merely because it resembles a starred repo (that repo is someone else's, not the builder's). Only the builder's OWN [WORK]/authored repos are exclusions.
- Prefer NEW directions over PRs into large established upstream repos the builder already contributes to; those are out of scope unless clearly novel.

Output: a ranked markdown list (best first). For each idea:
  ## N. <short title>
  - **What:** one or two sentences.
  - **Why it fits:** ties to a specific skill/interest in the profile.
  - **Why now / why new:** the web finding that makes it timely, with source URL(s) that actually support the claim (right artifact, date, mechanism).
  - **Validation:** the prior-art / competitor search behind the idea's load-bearing claim -- the closest existing tools you found (with URLs), or the query that came up empty, and whether novelty/timeliness survived. If the search narrowed the idea, say how.
  - **First slice:** the smallest thing they could ship to test the idea.
  - **Size:** one of S | M | L | XL -- a RELATIVE t-shirt size for the whole idea, NOT a calendar estimate. Rubric: S=an afternoon, M=a weekend, L=about a week, XL=multi-week. Pick the bucket; do not write hours/weeks.
  - **Why this rank:** one line naming the axes that set its position vs the others -- fit (skill match), novelty (distance from what they already do), timeliness (how hot the web finding is), reach (how far outside their current orbit). State which axis carried it and which one held it back, e.g. "high novelty + a release this month; below #1 only because the skill match is thinner."

Two more rules on the ranking itself:
- RANK ORDER IS A CLAIM. The list is ordered best-first; "Why this rank" must justify the POSITION, not restate "Why it fits". Compare each idea to its neighbors -- what makes it beat the one below and trail the one above. If you cannot name a discriminating reason, the order is wrong: re-sort.
- NEVER rank on an unchecked claim. When a position rests on novelty or timeliness, it must ride on the validated claim from the idea's **Validation:** field, not an assumed one. An idea whose premise failed the check ranks below one whose premise held -- however exciting the failed one sounded.
- Be honest about the weak axis. Every idea trades something off (thin skill match, crowded space, speculative timing). Name it. An idea with no stated weakness reads as flattery and is less useful than one with a clear caveat.`;

const MARKET_BLOCK = `

ALSO REQUIRED THIS RUN -- market reality. The builder wants each idea grounded in who would actually use or pay for it, not just whether it's novel and fits. Add one more field to every idea, AFTER "Why this rank":
  - **Market:** real competitors / existing alternatives (name them, with a source URL where you can) + who concretely would use or pay for this (the specific orgs, teams, or communities) + a one-word revenue read (none | indirect | plausible | proven). If the honest answer is "nobody pays and three tools already do it," say that -- a dead market is a finding.
Web-search for the competitors and the demand signal; do not guess them. And let this inform the ranking: an idea with a real, underserved audience should beat an equally-novel idea with no one waiting for it -- note that in "Why this rank" when it moves the order.`;

const ORBIT_SYSTEM_BLOCK = `

ALSO THIS RUN -- ORBIT MODE IS ON. The builder has named a CENTER they want this run to revolve around (see the ORBIT section in the task). This OVERRIDES the "Outward and wide" rule: do NOT prefer ideas outside their current orbit this run -- the named orbit IS the target. For THIS run:
- Replace the "reach (how far outside their current orbit)" ranking axis with "orbit fit" -- how squarely the idea sits in the builder's named center while still being new to them. Rank by orbit fit + novelty (a fresh angle on the center) + timeliness.
- Add a "**Why in orbit:**" line to every idea, right after "**Why it fits:**", naming the load-bearing tie to the builder's named center.
- Everything else still binds: NEW only (honor every exclusion list), grounded web findings + source URLs, OFF-LIMITS WORK ECOSYSTEMS, CURRENTLY PURSUING orthogonality, AVOID THIS FLAVOR, and EXTRA RULES.
- Spread AROUND the center; do not converge on one spot restated six times. Vary the angle, the layer (primitive / tool / app / research), and the distance so the list genuinely explores the orbit.`;

// Capped at 4 deliberately: each idea costs a couple of prior-art/competitor
// searches, and long runs blow past the watchdog cap and die mid-flight. Four
// validated ideas finishes inside budget; more is what hangs.
const SYSTEM_CLOSE = '\n\nReturn EXACTLY 4 ideas -- no more. Each idea costs real verification searches, so keep the list to 4 and spend the searches making those 4 solid rather than padding the count. End with a one-line note on which two you would start with.';

const NATIVE_INTENT_DIRECTIVE = `=== NATIVE ATRIUM INTENT PROFILE (no external profile dependency) ===
Atrium has already assembled the builder profile in this prompt. Do not invoke profile-mining helpers or search local profile folders; use the sections below directly.

Use these signals in priority order:
- STATED INTERESTS are the strongest positive signal. Match every idea to at least one stated interest or an explicit positive prior rating.
- [STARRED] GitHub repos are positive taste signals for themes the builder likes but has not necessarily built.
- Authored GitHub repos and LOCAL PROJECTS ON DISK are mostly "already does this" exclusions. They prove capability and current orbit, but they are not positive interest signals by themselves.
- [WORK] tags and OFF-LIMITS WORK ECOSYSTEMS come from work.md/work.txt. Propose nothing in or adjacent to those ecosystems.
- EXTRA RULES come from rules.md and are standing instructions for this run.

VALIDATE the claims, don't assert them. Before you call an idea novel, first, or "nothing exists for X", actually search for the closest existing tool / paper / competitor and a real date for any timeliness claim — state what you found (with a URL) or the query that came up empty, in a **Validation:** line on each idea. A "no X exists" claim you did not search for is wrong, not bold; drop or narrow an idea whose premise the search kills.

CONVERGE — don't search forever, but DO spend the searches verification needs. Budget a couple of prior-art/competitor checks per idea on top of the finding that sparked it; once each idea's load-bearing claim is checked, STOP and WRITE the full ranked idea list in the required format, then end. Endless "rounding out" with no list is a FAILED run, but so is a list of unchecked "first / novel" claims — a written list of EXACTLY 4 grounded, validated ideas is the goal. Four is a hard cap: more ideas means more searches and the run dies before it writes. Output the '## N.' ideas once their claims are checked, not before and not after more aimless searching.`;

const COLLISION_SYSTEM_BLOCK = `

ALSO THIS RUN -- COLLISION MODE IS FULLY ON. This OVERRIDES the normal run shape: do NOT produce a normal idea list. EVERY idea you return this run is a collision idea, built by bridging the builder's skills with a sampled real domain from the COLLISION BRIDGE section in the task. There is no separate "main list" -- the whole run is collisions. So for THIS run:
- The usual "Fits them" profile-match constraint is SUSPENDED. Every idea SHOULD sit far from the demonstrated profile -- that distance is the point. Do not snap any idea back toward what the builder already does.
- Replace the mandatory "**Why it fits:**" field with "**Why the bridge holds:**" on every idea -- one line naming the real, load-bearing link between the builder's skills and that idea's sampled domain (why it genuinely needs both).
- Add "**Sampled domain:**" immediately before "**Why the bridge holds:**" on every idea, using the exact sampled domain string from the COLLISION BRIDGE list. This lets itch persist the collision context as structured metadata.
- Tag EVERY idea title with [collide]. Rank the whole list by NOVELTY first (distance from what they already do), then by bridge strength.
Everything else (NEW only, grounded web findings + source URLs, VALIDATED claims -- no unchecked "nothing exists" / "first" -- OFF-LIMITS work ecosystems, CURRENTLY PURSUING orthogonality, AVOID THIS FLAVOR, EXTRA RULES, honest weak-axis) still applies to every idea.`;

const COLLISION_DIRECTIVE = `
=== COLLISION BRIDGE (sampled real domains) ===
You have been handed real domains sampled from a live taxonomy, deliberately drawn OUTSIDE your current orbit at a tuned distance from your demonstrated interests:
{seeds}

These are REAL published fields, never invented, sampled at a TUNED DISTANCE from the builder's interests (the chaos temperature): the closer the temperature, the nearer these domains sit to their orbit; the higher, the wilder. EVERY idea you return this run must be a collision: take a sampled domain and bridge it with the builder's demonstrated skills and interests above (systems / performance / inference / distributed primitives). Do NOT return any "normal" idea -- there is no main list this run, the whole list is collisions.

Pick the 4 strongest domains for collisions (one idea each; EXACTLY 4 ideas total spread across distinct domains). Each bridge must be LOAD-BEARING: the core problem AND the solution must REQUIRE both sides -- the builder's expertise applied to a real bottleneck IN that domain, or a tool/library that authentically lives in both. A cosmetic mention of the domain is a failed bridge.

Do NOT fabricate a connection. If a sampled domain has NO real substrate to bridge (the only link would be wordplay), skip that one and lean on the others -- but distant-but-real is the target, not a reason to bail.

Tag EVERY idea title with [collide]. Rank the whole list by NOVELTY first, then bridge strength. Collision ideas are NOT exempt from OFF-LIMITS WORK ECOSYSTEMS, CURRENTLY PURSUING orthogonality, AVOID THIS FLAVOR, or EXTRA RULES.

For every idea, include this field order:
  - **What:**
  - **Sampled domain:** <exact sampled domain from the list above>
  - **Why the bridge holds:**
  - **Why now / why new:** <with source URL(s)>
  - **Validation:** <closest prior art / competitors checked, with URLs, or the queries that came up empty; whether the novelty/timeliness claim survived>
  - **First slice:**
  - **Size:**
  - **Why this rank:**`;

const ORBIT_DIRECTIVE = `
=== ORBIT (the builder named a center for THIS run) ===
The builder wants this run's ideas to ORBIT a specific center they wrote below -- a theme, a technology, a problem space, or a half-formed idea they want to explore RIGHT NOW. This is the gravitational center for the whole run; treat it as a deliberate narrowing of WHERE to look, not a relaxation of anything else.

--- THE BUILDER'S ORBIT NOTES (verbatim) ---
{orbit}

- EVERY idea must sit in meaningful orbit around this center -- a distinct angle, application, layer, or adjacent opening ON it. If an idea does not connect to the orbit in a load-bearing way, drop it; do NOT pad the list with a tour of the broader field.
- Still NEW to the builder. The orbit names where to look; it does NOT license re-proposing what they already do (honor every exclusion list above) or the exact thing the notes describe. Return fresh directions WITHIN the orbit they have not already taken.
- Still grounded + deep. Each idea needs a real, recent web finding INSIDE the orbit (release, paper, tool, gap, unmet need) with source URL(s). Search the orbit deeply rather than wide.
- Spread AROUND the center, do not converge on one spot: vary the angle, the layer (primitive / tool / app / research), and the distance so the set explores the orbit instead of restating it.
- OFF-LIMITS work ecosystems, CURRENTLY PURSUING orthogonality, AVOID THIS FLAVOR, and the builder's EXTRA RULES all still apply within the orbit.`;

const USER_TEMPLATE = `Here is the builder's profile. Use it ONLY to understand what they already do so you can return things that are new to them.

{intent_directive}

=== LOCAL PROJECTS ON DISK ({projects_dir} -- already have these; exclude only) ===
{local}

=== PUBLIC GITHUB REPOS ({owners}) ===
{repos}

=== CURRENTLY PURSUING (rated 5 -- the builder is actively building these or a direct extension; propose ONLY ideas that are deliberately ORTHOGONAL, never extensions, never adjacencies, never "phase 2" ideas) ===
{prior_pursued}

=== ALREADY BUILT (the builder pursued these and FINISHED or still MAINTAINS them; each is tagged [finished]/[maintaining] and may carry a note on how it feels) -- do NOT re-propose the title or a direct extension, BUT treat these as a POSITIVE TASTE signal: the builder ships things of this flavor, so lean toward new, orthogonal ideas that share the qualities they liked here ===
{prior_built}

=== ALREADY SUGGESTED LAST RUN -- HARD EXCLUSION ===
{prior_hard}

=== RECENTLY SUGGESTED (within last 5 runs, decaying) -- skip unless you have a substantially different angle, in which case prefix the title with "↻ " ===
{prior_soft}

=== AVOID THIS FLAVOR (the builder dropped these and left a reason -- the exact title is fair game again, but propose NOTHING of the same flavor the note describes. Ideas the builder PURSUED and then dropped are the strongest signal here: they committed and bailed, so steer especially wide of that flavor. These decay out after a few runs) ===
{prior_avoid}

=== EXTRA RULES (freeform steer the builder wrote in rules.md -- honor these directly) ===
{rules}

=== OFF-LIMITS WORK ECOSYSTEMS (the builder's day job -- propose NOTHING here) ===
{offlimits}
{collision_directive}{orbit_directive}{corroboration}
=== TASK ===
Use your web search tools now and return a ranked list of NEW things to build or explore, following every rule in your instructions. Today is {today}.`;

const STRUCTURED_OUTPUT_DIRECTIVE = `

=== STRUCTURED OUTPUT (MANDATORY -- the very last thing in your answer) ===
After the full markdown idea list, END your answer with exactly ONE fenced \`\`\`json block, with nothing after it:

\`\`\`json
{"ideas":[{"idx":1,"title":"<EXACT heading title incl any [collide] prefix>","score":<0-100 profile-fit>,"pitch":"<one sentence>","domains":["..."],"effort":"weekend|week|month"}]}
\`\`\`

One entry per idea heading, in list order, idx counting from 1. "title" must reproduce the heading text after the number character-for-character (including any [collide] prefix) -- the tooling keys on it. "score" is your honest 0-100 fit against the builder's profile, "pitch" one sentence, "domains" the idea's domain tags, "effort" one of weekend|week|month. Valid JSON only, no comments, no trailing prose.`;

export function composeSystemPrompt(opts: { market?: boolean; collide?: boolean; orbit?: boolean } = {}): string {
  // collide (scatter wide) and orbit (focus tight) are opposites and never co-occur.
  const parts = [SYSTEM_PROMPT];
  if (opts.market) parts.push(MARKET_BLOCK);
  if (opts.collide) parts.push(COLLISION_SYSTEM_BLOCK);
  if (opts.orbit) parts.push(ORBIT_SYSTEM_BLOCK);
  return parts.join('') + SYSTEM_CLOSE;
}

export async function loadWorkPatterns(): Promise<Set<string>> {
  const texts = await Promise.all([WORK_MD_FILE, WORK_FILE].map((path) => readFile(path, 'utf8').catch(() => '')));
  const pats = new Set<string>();
  for (const text of texts) {
    for (const ln of text.split('\n')) {
      const s = ln.trim();
      if (s && !s.startsWith('#')) pats.add(s);
    }
  }
  return pats;
}

function tag(name: string, owner: string | null, patterns: Set<string>): string {
  const cands = new Set([name]);
  if (owner) { cands.add(owner); cands.add(`${owner}/${name}`); }
  for (const c of cands) if (patterns.has(c)) return '[WORK] ';
  return '';
}

export async function loadLocalProjects(projectsDir: string, work: Set<string>): Promise<string> {
  let names: string[] = [];
  try {
    const entries = await readdir(projectsDir);
    names = entries.filter((n) => !n.startsWith('.')).sort();
  } catch {
    return `[no local projects dir at ${projectsDir}]`;
  }
  if (!names.length) return '[no local projects found]';
  return names.map((n) => `- ${tag(n, null, work)}${n}`).join('\n');
}

export async function loadGhRepos(owners: string[], work: Set<string>): Promise<string> {
  const lines: string[] = [];
  let authored = 0;
  for (const owner of owners) {
    const out = await run('gh', ['repo', 'list', owner, '--limit', '300', '--json', 'name,description,primaryLanguage,isArchived']);
    if (!out) { lines.push(`[could not list repos for ${owner}]`); continue; }
    let repos: any[] = [];
    try { repos = JSON.parse(out); } catch { lines.push(`[bad gh output for ${owner}]`); continue; }
    for (const r of repos) {
      if (r.isArchived) continue;
      const lang = r.primaryLanguage?.name || '?';
      const desc = r.description || '';
      authored += 1;
      lines.push(`- ${tag(r.name, owner, work)}${owner}/${r.name} [${lang}] ${desc}`.trim());
    }
  }
  let starred = 0;
  const login = await ghLogin();
  const starredOut = login
    ? await run('gh', ['api', '--paginate', `users/${login}/starred?per_page=100`, '--jq', '.[] | [.full_name, (.language // "?"), (.description // "")] | @tsv'])
    : '';
  for (const row of starredOut.split('\n')) {
    if (!row.trim()) continue;
    const parts = row.split('\t');
    const full = parts[0]?.trim();
    if (!full) continue;
    const lang = parts[1]?.trim() || '?';
    const desc = parts[2]?.trim() || '';
    starred += 1;
    lines.push(`- [STARRED] ${full} [${lang}] ${desc}`.trim());
  }
  if (!lines.length) return '[no repos found]';
  const summary = `[GitHub scan loaded: ${authored} authored repos${login ? ` for ${owners.join(', ') || login}` : ''}; ${starred} starred repos${login ? ` for ${login}` : ''}]`;
  return [summary, ...lines].join('\n');
}

export async function loadRules(): Promise<string> {
  const text = await readFile(RULES_FILE, 'utf8').catch(() => '');
  return text.trim() || '[none]';
}

async function buildIntentDirective(): Promise<string> {
  const interests = await readFile(INTERESTS_FILE, 'utf8').catch(() => '');
  return `${NATIVE_INTENT_DIRECTIVE}\n\n=== STATED INTERESTS (authoritative positive signal from interests.md) ===\n${interests.trim() || '[none configured]'}`;
}

async function runStems(beforeStem?: string | null): Promise<string[]> {
  let files: string[] = [];
  try { files = await readdir(RUNS_DIR); } catch { return []; }
  let stems = files.filter((f) => /^\d{8}-\d{6}(?:-\d{3})?\.md$/.test(f)).map((f) => f.slice(0, -3)).sort().reverse();
  if (beforeStem) stems = stems.filter((s) => s < beforeStem);
  return stems;
}

function stemIdx(stem: string, stems: string[]): number {
  return stems.filter((s) => s > stem).length;
}

function readRunIdeaTitles(markdown: string): string[] {
  const titles: string[] = [];
  const seen = new Set<string>();
  for (const ln of markdown.split('\n')) {
    const m = ln.match(IDEA_RE);
    if (!m) continue;
    const t = m[1].trim().replace(RESURFACE_RE, '').trim();
    const key = t.toLowerCase();
    if (t && !seen.has(key)) { seen.add(key); titles.push(t); }
  }
  return titles;
}

export async function loadPriorIdeasDecayed(beforeStem?: string | null): Promise<{ pursued: string; hard: string; soft: string; avoid: string; built: string }> {
  const stems = await runStems(beforeStem);
  if (!stems.length) return { pursued: '[none]', hard: '[none yet]', soft: '[none]', avoid: '[none]', built: '[none]' };
  type Seen = { display: string; idx: number; rating: number | null; note: string | null; outcome: string | null; onote: string | null };
  const seen = new Map<string, Seen>();
  for (let idx = 0; idx < Math.min(stems.length, PURSUED_LOOKBACK); idx++) {
    const text = await readFile(join(RUNS_DIR, `${stems[idx]}.md`), 'utf8').catch(() => '');
    if (!text) continue;
    for (const t of readRunIdeaTitles(text)) {
      const key = t.toLowerCase();
      if (!seen.has(key)) seen.set(key, { display: t, idx, rating: null, note: null, outcome: null, onote: null });
    }
  }
  const ledger = (await readJson<Record<string, any>>(DECISIONS_FILE)) ?? {};
  for (const [key, e] of Object.entries(ledger)) {
    if (!e || typeof e !== 'object') continue;
    const asOf = typeof e.as_of === 'string' ? e.as_of : '';
    if (beforeStem && asOf >= beforeStem) continue;
    const idx = stemIdx(asOf, stems);
    const prev = seen.get(key);
    const display = (typeof e.title === 'string' ? e.title : null) ?? prev?.display ?? key;
    seen.set(key, { display, idx, rating: e.rating ?? null, note: e.note ?? null, outcome: e.outcome ?? null, onote: e.outcome_note ?? null });
  }
  const pursued: [string, string | null][] = [];
  const hard: [string, string | null][] = [];
  const soft: [string, string | null][] = [];
  const avoid: [string, string | null][] = [];
  const built: [string, string | null][] = [];
  for (const { display, idx, rating, note, outcome, onote } of seen.values()) {
    if (outcome === 'finished' || outcome === 'maintaining') { if (idx < PURSUED_LOOKBACK) built.push([`[${outcome}] ${display}`, onote]); continue; }
    if (outcome === 'dropped') { if (idx < PURSUED_LOOKBACK) avoid.push([display, onote || note]); continue; }
    if (rating === 5) { if (idx < PURSUED_LOOKBACK) pursued.push([display, note]); continue; }
    if (rating === 1) { if (note && idx < DECAY_TOTAL) avoid.push([display, note]); continue; }
    if (rating === 2) { if (idx > 0 && idx < 2) soft.push([display, note]); continue; }
    if (rating === 4) { if (idx < 2) hard.push([display, note]); else if (idx < DECAY_TOTAL + 2) soft.push([display, note]); continue; }
    if (idx === 0) hard.push([display, note]); else if (idx < DECAY_TOTAL) soft.push([display, note]);
  }
  const fmt = (xs: [string, string | null][], empty: string): string => xs.length ? xs.map(([t, n]) => n ? `- ${t} — ${n}` : `- ${t}`).join('\n') : empty;
  return { pursued: fmt(pursued, '[none]'), hard: fmt(hard, '[none yet]'), soft: fmt(soft, '[none]'), avoid: fmt(avoid, '[none]'), built: fmt(built, '[none]') };
}

export interface ResearchOptions {
  market?: boolean;
  collisionSeeds?: string[];
  orbit?: string;
  owners?: string[];
  useGh?: boolean;
  useLocal?: boolean;
  work?: string[];
  projectsDir?: string;
  noHistory?: boolean;
  historyBeforeStem?: string | null;
  /** Pre-rendered TRANSCRIPT CORROBORATION block (from formatCorroboration);
   *  empty string when sxc mining is unavailable/disabled. */
  corroboration?: string;
}

export async function buildUserPrompt(opts: ResearchOptions = {}): Promise<string> {
  const projectsDir = opts.projectsDir || DEFAULT_PROJECTS_DIR;
  const owners = opts.owners?.length ? opts.owners : await defaultOwners();
  const work = new Set([...(opts.work ?? []), ...(await loadWorkPatterns())]);
  const prior = opts.noHistory
    ? { pursued: '[history disabled]', hard: '[history disabled]', soft: '[history disabled]', avoid: '[history disabled]', built: '[history disabled]' }
    : await loadPriorIdeasDecayed(opts.historyBeforeStem ?? null);
  const local = opts.useLocal === false ? '[local scan skipped]' : await loadLocalProjects(projectsDir, work);
  const repos = opts.useGh === false ? '[GitHub scan skipped]' : await loadGhRepos(owners, work);
  const rules = await loadRules();
  const intent = await buildIntentDirective();
  const collisionDir = opts.collisionSeeds?.length
    ? fillTemplate(COLLISION_DIRECTIVE, { seeds: opts.collisionSeeds.map((d) => `- ${d}`).join('\n') })
    : '';
  const orbitDir = opts.orbit?.trim() ? fillTemplate(ORBIT_DIRECTIVE, { orbit: opts.orbit.trim() }) : '';
  const today = new Date().toISOString().slice(0, 10);
  return fillTemplate(USER_TEMPLATE, {
    intent_directive: intent,
    projects_dir: projectsDir,
    local,
    owners: owners.join(', '),
    repos,
    prior_pursued: prior.pursued,
    prior_built: prior.built,
    prior_hard: prior.hard,
    prior_soft: prior.soft,
    prior_avoid: prior.avoid,
    rules,
    offlimits: work.size ? `from work.md/work.txt: ${[...work].sort().join(', ')}` : '[none configured]',
    collision_directive: collisionDir,
    orbit_directive: orbitDir,
    corroboration: opts.corroboration ?? '',
    today,
  }) + STRUCTURED_OUTPUT_DIRECTIVE;
}

async function ghLogin(): Promise<string> {
  return (await run('gh', ['api', 'user', '--jq', '.login'], 15_000)).trim();
}

export async function defaultOwners(): Promise<string[]> {
  const env = process.env.ITCH_OWNERS?.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  if (env?.length) return env;
  const who = await ghLogin();
  return who ? [who] : [];
}

export function parseStructuredIdeas(mdText: string): any | null {
  try {
    const blocks = [...mdText.matchAll(/```json[ \t]*\n(.*?)\n[ \t]*```/gis)].map((m) => m[1]);
    if (!blocks.length) return null;
    const data = JSON.parse(blocks[blocks.length - 1]);
    if (!data || typeof data !== 'object') return null;
    const ideas = data.ideas;
    if (!Array.isArray(ideas) || !ideas.length) return null;
    for (const it of ideas) {
      if (!it || typeof it !== 'object') return null;
      // Python uses type(x) is int (rejects bool/float); JS parity: integer + not boolean.
      if (typeof it.title !== 'string') return null;
      if (typeof it.idx !== 'number' || !Number.isInteger(it.idx)) return null;
      if (typeof it.score !== 'number' || !Number.isInteger(it.score) || it.score < 0 || it.score > 100) return null;
    }
    const headings = new Set<string>();
    for (const ln of mdText.split('\n')) {
      const m = ln.match(IDEA_RE);
      if (m) headings.add(m[1].trim().replace(RESURFACE_RE, '').trim());
    }
    const titles = ideas.map((it: any) => it.title.trim().replace(RESURFACE_RE, '').trim());
    if (new Set(titles).size !== headings.size) return null;
    for (const t of titles) if (!headings.has(t)) return null;
    ideas.forEach((it: any, i: number) => { it.title = titles[i]; });
    return data;
  } catch {
    return null;
  }
}

/** Stable key for "same research setup" with collision_temp removed (matches the
 * Python _compare_key_from_meta byte-for-byte: sorted keys, compact separators). */
export function compareKeyFromMeta(meta: Record<string, any>): string {
  const flags = meta?.flags && typeof meta.flags === 'object' ? meta.flags : {};
  const payload = {
    model: meta?.model || DEFAULT_MODEL_ID,
    owners: Array.isArray(meta?.owners) ? meta.owners : [],
    projects_dir: meta?.projects_dir || DEFAULT_PROJECTS_DIR,
    work: [...(Array.isArray(meta?.work) ? meta.work : [])].map(String).sort(),
    flags: {
      no_gh: !!flags.no_gh,
      no_local: !!flags.no_local,
      no_history: !!flags.no_history,
      fresh: !!flags.fresh,
      market: !!flags.market,
    },
  };
  return stableStringify(payload);
}

/** JSON.stringify with sorted object keys, compact separators, AND ensure_ascii
 * escaping — byte-for-byte parity with Python
 * json.dumps(sort_keys=True, separators=(",", ":")) (default ensure_ascii=True).
 * compare_key must match across TS-written and Python-written runs, so non-ASCII
 * (unicode owners/paths/titles) must escape to \uXXXX exactly as Python does. */
function jsonEscapeAscii(str: string): string {
  let out = '"';
  for (const ch of str) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
    else if (code < 0x7f) out += ch;
    else if (code <= 0xffff) out += '\\u' + code.toString(16).padStart(4, '0');
    else {
      // astral plane -> UTF-16 surrogate pair (matches Python ensure_ascii)
      const c = code - 0x10000;
      const hi = 0xd800 + (c >> 10);
      const lo = 0xdc00 + (c & 0x3ff);
      out += '\\u' + hi.toString(16).padStart(4, '0') + '\\u' + lo.toString(16).padStart(4, '0');
    }
  }
  return out + '"';
}

function stableStringify(value: any): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return jsonEscapeAscii(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    // lexicographic key sort (Python sort_keys), NOT V8 integer-key ordering
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${jsonEscapeAscii(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const RUN_METADATA_VERSION = 1;

export function normalizeRunMetadata(data: any): { version: number; collide: { enabled: boolean; temperature: number | null; sampled_domains: string[] } } {
  const out = { version: RUN_METADATA_VERSION, collide: { enabled: false, temperature: null as number | null, sampled_domains: [] as string[] } };
  if (!data || typeof data !== 'object') return out;
  const rawCollide = data.collide;
  let enabled: boolean;
  let temp: any;
  let domains: any;
  if (rawCollide && typeof rawCollide === 'object' && !Array.isArray(rawCollide)) {
    enabled = !!rawCollide.enabled;
    temp = rawCollide.temperature;
    domains = rawCollide.sampled_domains;
  } else {
    enabled = !!data.collide;
    temp = data.collision_temp;
    domains = data.sampled_domains;
  }
  const flags = data.flags && typeof data.flags === 'object' ? data.flags : {};
  if (rawCollide !== undefined && !(rawCollide && typeof rawCollide === 'object' && !Array.isArray(rawCollide))) {
    if (flags.collision_temp !== undefined) temp = flags.collision_temp;
    domains = data.sampled_domains || data.collision_domains || domains;
  }
  const clean: string[] = [];
  if (Array.isArray(domains)) {
    const seen = new Set<string>();
    for (const d of domains) {
      if (typeof d !== 'string') continue;
      const t = d.trim();
      const key = t.toLowerCase();
      if (t && !seen.has(key)) { seen.add(key); clean.push(t); }
    }
  }
  out.version = Number(data.version || data.schema || RUN_METADATA_VERSION) || RUN_METADATA_VERSION;
  out.collide = { enabled, temperature: typeof temp === 'number' && Number.isFinite(temp) ? temp : null, sampled_domains: clean };
  return out;
}

/** Build the research run metadata (faithful to Python _research_run_meta). */
export function buildResearchRunMeta(opts: {
  model: string;
  flags: { no_gh: boolean; no_local: boolean; no_history: boolean; fresh: boolean; market: boolean };
  collisionTemp: number | null;
  orbit?: string | null;
  collisionSeeded: boolean;
  sampledDomains: string[];
  owners: string[];
  projectsDir: string;
  work: string[];
  historyBefore?: string | null;
  baselineFor?: string | null;
}): Record<string, any> {
  const flags = {
    no_gh: opts.flags.no_gh,
    no_local: opts.flags.no_local,
    no_history: opts.flags.no_history,
    fresh: opts.flags.fresh,
    market: opts.flags.market,
    collision_temp: opts.collisionTemp,
    orbit: (opts.orbit || '').trim() || null,
  };
  const meta: Record<string, any> = {
    schema: 1,
    model: opts.model || DEFAULT_MODEL_ID,
    owners: opts.owners,
    projects_dir: opts.projectsDir,
    work: opts.work,
    flags,
    collide: !!(opts.collisionTemp && opts.collisionTemp > 0),
    collision_seeded: opts.collisionSeeded,
    sampled_domains: opts.sampledDomains,
    history_before: opts.historyBefore || null,
    baseline_for: opts.baselineFor || null,
  };
  meta.compare_key = compareKeyFromMeta(meta);
  return meta;
}

export async function saveRun(text: string, meta?: Record<string, unknown>): Promise<string> {
  await mkdir(RUNS_DIR, { recursive: true });
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  let stem = ts;
  let saved = false;
  for (let attempt = 0; attempt < 1000; attempt++) {
    stem = attempt === 0 ? ts : `${ts}-${String(attempt).padStart(3, '0')}`;
    const path = join(RUNS_DIR, `${stem}.md`);
    try {
      // Exclusive create (O_EXCL parity): never overwrite an existing run; the
      // collision suffix loop only advances on a genuine name clash.
      await writeFile(path, `${text}\n`, { encoding: 'utf8', flag: 'wx' });
      saved = true;
      break;
    } catch (err: any) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
  }
  if (!saved) throw new Error(`could not allocate a unique run path for ${ts}`);
  if (meta) {
    const clean: Record<string, any> = { ...meta, schema: 1, stem, created_at: new Date().toISOString() };
    if (!clean.compare_key) clean.compare_key = compareKeyFromMeta(clean);
    await atomicWrite(join(RUNS_DIR, `${stem}.meta.json`), JSON.stringify(clean, null, 2));
  }
  const structured = parseStructuredIdeas(text);
  if (structured) await atomicWrite(join(RUNS_DIR, `${stem}.ideas.json`), JSON.stringify(structured, null, 2) + '\n');
  return stem;
}

// --- collide sampler (real domains at a tuned semantic distance) ------------
// The sampler is a torch/bge ML helper (needs sentence-transformers); itch runs
// it CPU-only and degrades GRACEFULLY to [] (exact baseline) on any failure.
const SXC_PY = process.env.ITCH_SXC_PY || join(HOME, 'projects', 'splade-3-colbert-2', '.venv', 'bin', 'python');
const COLLIDE_SAMPLE_PY = process.env.ITCH_COLLIDE_SAMPLE || join(HOME, 'projects', 'atrium', 'itch-collide', 'collide_sample.py');

export async function sampleCollisionDomains(temperature: number, k = 8): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      const env = { ...process.env, COLLIDE_DEVICE: process.env.ITCH_COLLIDE_DEVICE || process.env.COLLIDE_DEVICE || 'cpu' };
      execFile(SXC_PY, [COLLIDE_SAMPLE_PY, '--temp', String(temperature), '--k', String(k)],
        { timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env },
        (err, stdout) => {
          if (err) { resolve([]); return; }
          try {
            const titles = JSON.parse(String(stdout).trim() || '[]');
            if (!Array.isArray(titles)) { resolve([]); return; }
            resolve(titles.map((t: unknown) => String(t).trim()).filter(Boolean));
          } catch {
            resolve([]);
          }
        });
    } catch {
      resolve([]);
    }
  });
}

// --- transcript corroboration miner (sxc ranked retrieval) ------------------
// Grounds each interest seed against the builder's OWN past transcripts/notes
// via the splade-3-colbert-2 (sxc) index, so the model sees genuine recurring
// signal (and where it showed up) instead of reasoning blind. CPU by default
// (a ColBERT query is ~32ms once the index is warm; the one-time load amortises
// across the whole seed batch in a single background run) so this never needs
// the GPU and never contends with anything else on the box. Degrades GRACEFULLY
// to [] (exact ungrounded baseline) on any failure — missing index, stale
// rebuild, sxc import error — mirroring the collide sampler's contract.
const MINE_PY = process.env.ITCH_MINE_PY || join(HOME, 'projects', 'atrium', 'itch-collide', 'mine_transcripts.py');
// Distilled-knowledge tiers (README/memory/skill/paper/surreal) are weighted
// BELOW transcript tiers for corroboration, per the itch-intent skill: a stated
// interest echoed across one's own conversations is stronger signal than a doc.
const TRANSCRIPT_SOURCES = new Set(['claude', 'codex', 'hermes', 'eigen']);
// Echo-chain guard (see itch-collide/intent_recency.py): itch's OWN scout runs
// flood the transcripts and would self-corroborate every idea it ever proposed.
// Drop hits whose project is an itch run dir or the itch app itself so
// corroboration reflects genuine work/conversation, not itch feeding itself.
const ITCH_SELF_PROJECT = /(?:^|[^a-z])itch(?:$|[^a-z])|atrium-itch/i;
const MINE_MAX_SEEDS = Number(process.env.ITCH_MINE_MAX_SEEDS || 16);
const MINE_TIMEOUT_MS = Number(process.env.ITCH_MINE_TIMEOUT_MS || 180_000);

export interface MineHit {
  source: string;
  project: string | null;
  session_id: string;
  ts: number | null;
  score: number;
  quote: string;
}
export interface MineSeedResult { seed: string; hits: MineHit[]; }
export interface MineResult { retriever: string; seeds: MineSeedResult[]; }

/** Pull stated-interest seed terms from interests.md "What I'm drawn to" bullets.
 *  These are the AUTHORITATIVE positive signal; we corroborate THEM against the
 *  transcripts (not arbitrary frequency terms), which keeps the MEANS-vs-ENDS
 *  guard intact — we surface where a stated interest actually showed up. */
export async function loadInterestSeeds(max = MINE_MAX_SEEDS): Promise<string[]> {
  const text = await readFile(INTERESTS_FILE, 'utf8').catch(() => '');
  if (!text.trim()) return [];
  const seeds: string[] = [];
  let inDrawn = false;
  for (const raw of text.split('\n')) {
    const ln = raw.trim();
    if (/^#+\s/.test(ln)) {
      // Section gate: collect only under a "drawn to" heading, stop at the
      // anti-signal ("NOT drawn to") section.
      inDrawn = /drawn to/i.test(ln) && !/not drawn to/i.test(ln);
      continue;
    }
    if (!inDrawn) continue;
    const m = ln.match(/^[-*]\s+(.+)$/);
    if (!m) continue;
    // Take the lead clause before the first parenthetical / em-dash / period —
    // the bullet's headline, not its whole prose, makes a tighter query.
    let term = m[1].split(/\s+[—–-]\s+|\.\s|\(/)[0].trim();
    term = term.replace(/[.,;:]+$/, '').trim();
    if (term.length >= 4 && term.split(/\s+/).length <= 12) seeds.push(term);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of seeds) {
    const k = s.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out.slice(0, max);
}

/** Run the sxc miner over seeds (CPU). Returns {retriever, seeds:[]} on any
 *  failure so the caller can fold in an empty corroboration block. */
export async function mineTranscripts(seeds: string[], k = 4): Promise<MineResult> {
  const empty: MineResult = { retriever: 'none', seeds: [] };
  const terms = seeds.map((s) => s.trim()).filter(Boolean).slice(0, MINE_MAX_SEEDS);
  if (!terms.length) return empty;
  return new Promise<MineResult>((resolve) => {
    try {
      const env = {
        ...process.env,
        ITCH_MINE_DEVICE: process.env.ITCH_MINE_DEVICE || 'cpu',
      };
      const child = execFile(
        SXC_PY, [MINE_PY, '--k', String(k), '--max-seeds', String(MINE_MAX_SEEDS)],
        { timeout: MINE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env },
        (err, stdout) => {
          if (err) { resolve(empty); return; }
          try {
            const parsed = JSON.parse(String(stdout).trim() || '{}');
            if (!parsed || !Array.isArray(parsed.seeds)) { resolve(empty); return; }
            resolve({ retriever: String(parsed.retriever ?? 'unknown'), seeds: parsed.seeds });
          } catch { resolve(empty); }
        },
      );
      child.stdin?.end(JSON.stringify(terms));
    } catch { resolve(empty); }
  });
}

/** Render mined hits into a prompt block: per seed, the corroborating sources
 *  (transcript tiers first, distilled-knowledge tiers flagged) with a short
 *  quote. Empty string when nothing corroborated, so the prompt slot vanishes. */
export function formatCorroboration(mined: MineResult): string {
  const lines: string[] = [];
  for (const s of mined.seeds) {
    const hits = (s.hits || []).filter((h) =>
      (h.quote || '').trim() && !(h.project && ITCH_SELF_PROJECT.test(h.project)));
    if (!hits.length) continue;
    const rendered = hits.slice(0, 4).map((h) => {
      const tier = TRANSCRIPT_SOURCES.has(h.source) ? h.source : `${h.source}(doc)`;
      const where = h.project ? `${tier}/${h.project}` : tier;
      const quote = h.quote.replace(/\s+/g, ' ').trim().slice(0, 200);
      return `    - [${where}] ${quote}`;
    });
    lines.push(`- "${s.seed}":\n${rendered.join('\n')}`);
  }
  if (!lines.length) return '';
  return (
    '\n=== TRANSCRIPT CORROBORATION (where each STATED INTEREST actually showed up in the ' +
    "builder's own transcripts/notes; ranked by the sxc retriever). Use ONLY to gauge which " +
    'interests are genuinely recurring vs noise — this is de-dup/grounding context, NOT a ' +
    'source of new ideas, and transcript tiers outweigh doc tiers. The NEW-only and ' +
    'orthogonality rules still bind. ===\n' +
    lines.join('\n')
  );
}

export { DEFAULT_PROJECTS_DIR };
