export const meta = {
  name: 'atrium-orgqueue',
  description: 'org queue lane: external PRs/issues waiting on me, ranked above my own PRs',
  phases: [
    { title: 'Build', detail: 'collector aliases + ranking; web lane + hero' },
    { title: 'Compile', detail: 'build + verify agent-sh items appear' },
    { title: 'Fix', detail: 'apply any review notes' },
  ],
}

const ROOT = '/home/avifenesh/projects/atrium'

const COMMON = [
  'Upgrading "atrium", a running life dashboard at ' + ROOT + ' (owner avifenesh, home /home/avifenesh). Service atrium.service holds 127.0.0.1:5599 — do not start a second instance there.',
  'CONTRACT (already written, match exactly, do NOT reshape): shared/types.ts now has OrgItem and GithubState.orgQueue. state.ts emptySnapshot already includes orgQueue: [].',
  'OWNER INTENT (binding ranking): external contributor PRs open on repos he owns/admins are people BLOCKED ON HIM — they rank ABOVE his own PRs ("more important than just my pr got reviewed"). Bots (dependabot, github-actions) are noise, filtered out. His own authored items are NOT in the org queue (they already live in myPRs/actNow).',
  'Read DESIGN.md (binding v2). RULES: TS strict; NodeNext .js suffixes server-side; no new deps; failure-isolated; secrets never emitted. Write ONLY your files. Final message: files + concerns, raw.',
].join('\n')

const SCHEMA = {
  type: 'object',
  properties: { files: { type: 'array', items: { type: 'string' } }, concerns: { type: 'array', items: { type: 'string' } } },
  required: ['files', 'concerns'],
}

phase('Build')

const built = await parallel([
  () => agent([
    COMMON,
    'YOU OWN: server/src/collectors/github.ts (extend; keep everything else working).',
    'GOAL: populate GithubState.orgQueue with open PRs + issues on repos avifenesh owns or admins, authored by OTHERS (not him, not bots).',
    'METHOD — fold into the EXISTING POLL_QUERY (the single aliased GraphQL search, cost ~1 point; NEVER use `gh search` here). Add aliases built from config.github.ownOrgs (currently ["agent-sh"]) and his own login:',
    '  orgExt: search(query: "is:open -author:LOGIN -author:app/dependabot -author:app/renovate archived:false ' + 'ORGFILTER", type: ISSUE, first: 50){ nodes { __typename ... on PullRequest { number title url createdAt updatedAt isDraft reviewDecision author{login} repository{nameWithOwner} commits(last:1){nodes{commit{statusCheckRollup{state}}}} } ... on Issue { number title url createdAt updatedAt author{login} repository{nameWithOwner} } } }',
    'where ORGFILTER = the ownOrgs joined as `org:agent-sh` plus `user:LOGIN` (his personal repos) — i.e. for each org "org:<o>" and one "user:<login>", joined with spaces. GitHub search ORs same-qualifier terms, so `org:agent-sh user:avifenesh` returns items in EITHER. (Verify this OR behavior; if search ANDs them, split into two aliases orgExt0/orgExt1 and merge.) Exclude github-actions bot too: add `-author:app/github-actions`. Note bot authors in search use the `app/` prefix; also defensively drop any node whose author.login ends with "[bot]" or is in {dependabot, github-actions, renovate} when mapping.',
    'MAP each node -> OrgItem (id "owner/repo#number", scope: repo owner in config.github.ownOrgs ? "org" : "own", kind from __typename, lane: pr->"review" issue->"triage", ci from statusCheckRollup.state null-safe, reviewDecision null-safe, isDraft default false for issues). Drop anything authored by config.github.login (defensive) or by a bot.',
    'RANK orgQueue (most-waiting first): (1) review-lane non-draft PRs, oldest updatedAt first (longest someone has waited); (2) review-lane draft PRs; (3) triage issues, oldest updatedAt first. Cap 50.',
    'FLAG (store.setFlags additions are fine, or fold into existing github flags array — keep existing flags!): if any review-lane non-draft PR has waited > 7 days (updatedAt older than 7d), info flag id "github:org-pr-stale" summarizing count. Keep existing rate-limit/poll flags intact.',
    'Set orgQueue on the GithubState you store via setSection (and include it in the lastGood cache object so it survives poll failures). Everything else in the collector stays byte-identical in behavior.',
  ].join('\n'), { label: 'build:collector', phase: 'Build', schema: SCHEMA }),

  () => agent([
    COMMON,
    'YOU OWN: web/src/panels/TasksPanel.tsx and web/src/panels/NowView.tsx (modify; keep all existing lanes/behavior). A parallel agent edits the server collector — you only consume snapshot.github.orgQueue (OrgItem[]).',
    'Read the current TasksPanel.tsx and NowView.tsx first — they already have: Row, SendToEigen, MuteButton (kinds github-item/github-repo/github-org), GithubLink (external "github" door), onOpenItem(repo, number) slide-over opener, isMuted, Panel with quietCount/onQuietClick. REUSE these exactly.',
    'TasksPanel: add a NEW lane "waiting on you" as the FIRST panel (riseIndex 0, above "act now"), col-span-12. It renders snapshot.github.orgQueue filtered through the same notMuted predicate (github-item cascade) and grouped: a small mono sublabel "review" for lane==="review" items then "triage" for lane==="triage" (use the existing section-label style). Each row (component, e.g. OrgRow): Row onClick={() => onOpenItem(repo, number)}; left: a tiny scope chip (mono "org"/"own"), repo (mono mist-faint), title (truncate), for PRs the draft/reviewDecision chips + ci Dot exactly like PRRow, RelTime updatedAt, and the hover cluster: author (mono mist-faint, e.g. "@lsaether"), GithubLink, SendToEigen (title/url/repo/sourceId=id), then MuteButton item/repo/org (RepoMutes pattern). Amber accent hairline on review-lane rows (these are top priority). quietCount = hidden count, onQuietClick=onOpenQuiet. Empty state: "nobody waiting".',
    'Renumber the existing panels (act now becomes riseIndex 1, etc.) so the stagger stays clean. Do not remove or reorder the existing "my repos" / "act now" / "my open prs" lanes otherwise — just insert org-queue first and shift indices.',
    'NowView: add a hero Stat "waiting" = count of orgQueue review-lane items (PRs awaiting you), accent amber when > 0, onClick={() => onNavigate("tasks")}. Place it FIRST in the hero strip (before "act now") since it outranks own work. Also: if orgQueue has any items, add a compact "waiting on you" Panel in the right column (top, riseIndex bumps) listing up to 5 review-lane items (Row -> onOpenItem, scope chip + repo + title + author + RelTime), so the landing view surfaces blocked-people immediately. Keep everything else in NowView intact; renumber riseIndex.',
    'Match DESIGN.md: amber only for the genuine attention (review lane), mono for ids/author/meta, truncation/min-w-0, no layout shift, slide-over opens in-app with the github door one click away. Quiet and focused.',
  ].join('\n'), { label: 'build:web', phase: 'Build', schema: SCHEMA }),
])
log('built ' + built.filter(Boolean).length + '/2')

phase('Compile')

const compile = await agent([
  'Make ' + ROOT + ' build clean and verify the org queue shows real external items. atrium.service holds 5599.',
  '1. cd ' + ROOT + ' && npm run build — fix every error (NodeNext .js suffixes, strict TS, tailwind v4). No shape changes to shared/types.ts; no new deps. If both builders touched a shared spot, merge intents.',
  '2. systemctl --user restart atrium.service; sleep 12; curl -s -X POST 127.0.0.1:5599/api/refresh/github; sleep 6.',
  '3. VERIFY orgQueue: curl -s 127.0.0.1:5599/api/snapshot | (python3) inspect github.orgQueue — MUST be non-empty and MUST include the known external items: agent-sh/agent-workspace-linux#17 (author lsaether, lane review) and agent-sh/agnix#1025 (author yegor256, lane triage). MUST NOT include any dependabot/github-actions-authored items, and MUST NOT include items authored by avifenesh. Print the first 10 {id, author, lane, isDraft}. Confirm review-lane PRs sort before triage issues.',
  '4. If the known items are missing, the search ORFILTER is wrong — diagnose (try the gh api graphql query directly), fix the collector, rebuild, re-verify. Do not finish until agent-sh external items appear correctly.',
  'Output: build status, the orgQueue sample, pass/fail on the known-items check, fixes applied.',
].join('\n'), { label: 'compile-verify', phase: 'Compile' })
log('compile: ' + String(compile).slice(0, 200))

phase('Fix')

const review = await agent([
  'Quick review of the org-queue changes in ' + ROOT + ' (server/src/collectors/github.ts, web NowView/TasksPanel). Check ONLY for real bugs: bot-filter actually excludes app/dependabot + *[bot]; own-authored items excluded (no dup with myPRs); ranking correct (external review PRs first); OrgItem fields match shared/types.ts; React keys/types correct; muted items hidden via existing cascade; no layout shift; existing lanes/flags untouched. Owner does NOT want confirm-friction or "managing own github is risky" findings. Return a short list of real fixes needed (file, line, problem, fix) or say clean.',
], { label: 'review', phase: 'Fix' })
log('review: ' + String(review).slice(0, 300))

return { compile: String(compile).slice(0, 1500), review: String(review).slice(0, 1500) }
