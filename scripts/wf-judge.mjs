export const meta = {
  name: 'atrium-masterpiece-judge',
  description: 'Three adversarial judges (typography/color, layout/rhythm, interaction/code) on the polish round, then one fixer',
  phases: [
    { title: 'Judge', detail: 'three lenses over screenshots + diff' },
    { title: 'Fix', detail: 'apply confirmed findings, rebuild green' },
  ],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          issue: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          fix: { type: 'string' },
        },
        required: ['file', 'issue', 'severity', 'fix'],
      },
    },
    verdict: { type: 'string' },
  },
  required: ['findings', 'verdict'],
}

const CONTEXT = [
  'PROJECT: /home/avifenesh/projects/atrium — "glass observatory" personal dashboard. A six-agent polish round just landed (uncommitted). Inspect it adversarially.',
  'See the working-tree diff: cd /home/avifenesh/projects/atrium && git diff (plus git status --short for new files: web/src/hooks.ts, web/src/components/Spark.tsx, web/src/components/CommandPalette.tsx).',
  'LIVE SCREENSHOTS (Read these image files): /home/avifenesh/projects/v4-now.png, v4-tasks.png, v4-agents.png, v4-system.png, v4-comms.png, v4-subs.png, v4-schedule.png, v4-notes.png, v4-palette.png, v4-slideover.png, v4-quiet.png (all in /home/avifenesh/projects/).',
  '',
  'DESIGN LAW (violations are findings): Instrument Serif appears EXACTLY twice (wordmark + now-view hero numerals) — the rail clock, palette, badges must be mono/sans. amber = act-now/attention ONLY, never decorative. jade ok, coral error. font-mono + tabular-nums for all data. everything lowercase. calm slow motion, prefers-reduced-motion respected. quiet = archive (unmount), .hover-cluster for row actions. No new npm deps allowed.',
  '',
  'Report ONLY real, actionable findings — things a discerning owner would notice or a bug that will bite. No nitpicks that change nothing for the user, no style preferences, no praise. severity: high = bug/design-law violation, medium = visible roughness, low = polish nice-to-have. Each finding names the file and a concrete fix.',
].join('\n')

phase('Judge')
const LENSES = [
  {
    key: 'discipline',
    prompt: [
      CONTEXT, '',
      'YOUR LENS: typography + color discipline. Check every screenshot and the diff for: a third serif use sneaking in (clock? palette? badges?); amber used decoratively (badges, counts, sparks where nothing needs action); wrong tone for state (jade/coral misuse); non-mono numerals or missing tabular-nums; uppercase/Title Case strings in UI; inconsistent label treatment across panels (the mono 11px uppercase tracking pattern).',
    ].join('\n'),
  },
  {
    key: 'rhythm',
    prompt: [
      CONTEXT, '',
      'YOUR LENS: layout, spacing, alignment. Scrutinize the screenshots at pixel level: misaligned columns, rows whose right-side meta ragged-edges, cramped or double gaps, truncation failures or overflow, the rail clock/badges alignment, palette geometry (centered? input/list/footer rhythm?), slide-over header rhythm, sparkline baseline alignment next to numerals in system view and the now-view system mini-row, empty space that reads as broken rather than calm, anything that looks unfinished at 1760px.',
    ].join('\n'),
  },
  {
    key: 'interaction',
    prompt: [
      CONTEXT, '',
      'YOUR LENS: interaction + code correctness. Read the diff hard (screenshots only as reference) for: keyboard handler bugs — shortcuts firing while typing in the notes editor / comment composer / palette input; Esc stacking (palette + slide-over + drawer open simultaneously — does one Esc close all at once?); event listener leaks (window listeners removed on unmount, rAF cancelled in useTweenNumber); React hook-order hazards (hooks after early returns, conditional hooks); useNow interval churn; recordSystemSample called from BOTH App.tsx and NowView.tsx (redundant — dedupe makes it harmless, but the NowView call should go); palette crash paths on partial snapshots (github sections empty/error state); Cmd/Ctrl+Enter handling; scroll-lock restore when two overlays close out of order; focus traps; stale closures in keydown handlers; tween behavior when value goes DOWN or component remounts; Spark with NaN/missing gpu values.',
    ].join('\n'),
  },
]

const judged = await parallel(
  LENSES.map((l) => () => agent(l.prompt, { label: `judge:${l.key}`, phase: 'Judge', schema: FINDINGS_SCHEMA })),
)
const all = judged.filter(Boolean).flatMap((j, i) => j.findings.map((f) => ({ ...f, lens: LENSES[i].key })))
const act = all.filter((f) => f.severity !== 'low')
log(`judges: ${all.length} findings, ${act.length} high/medium`)

phase('Fix')
if (act.length === 0) {
  return { findings: all, fixed: 'nothing to fix — judges came back clean', build: 'unchanged' }
}
const fixer = await agent(
  [
    'You are the fixer for /home/avifenesh/projects/atrium after an adversarial review of an uncommitted UI polish round.',
    'Apply ALL of these confirmed findings with minimal, correct edits (read each file before editing; verify the finding is real first — if one is wrong, skip it and say why):',
    '',
    JSON.stringify(act, null, 2),
    '',
    'DESIGN LAW: serif only wordmark + hero numerals; amber = attention only; font-mono tabular-nums for data; lowercase; calm motion; no new deps; shared/types.ts and web/src/api.ts read-only.',
    'When done: cd /home/avifenesh/projects/atrium && npm run build -w web — loop until green.',
    'Return: per finding — fixed (what edit) or skipped (why not real); final build status.',
  ].join('\n'),
  { label: 'fixer', phase: 'Fix' },
)
return { findings: all, applied: act.length, fixer }
