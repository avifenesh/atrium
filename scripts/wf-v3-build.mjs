export const meta = {
  name: 'atrium-v3-build',
  description: 'cursor+xai usage, notes editing, in-app github read/comment slide-over',
  phases: [
    { title: 'Build', detail: '4 builders, strict ownership' },
    { title: 'Compile', detail: 'build + endpoint smoke' },
    { title: 'Review', detail: 'real-bug + design lens (not "managing own github is risky")' },
    { title: 'Fix', detail: 'apply findings' },
  ],
}

const ROOT = '/home/avifenesh/projects/atrium'

const COMMON = [
  'You are upgrading "atrium", a working life dashboard at ' + ROOT + ' (owner avifenesh, home /home/avifenesh). It RUNS as systemd user service atrium.service on 127.0.0.1:5599 — do not start a second instance on that port.',
  'Read first: ' + ROOT + '/shared/types.ts (contract — recently extended: GithubItemDetail, GithubComment, and new API routes documented at bottom; match exactly, do not reshape), ' + ROOT + '/DESIGN.md (binding v2 design), ' + ROOT + '/server/src/{config,util,state}.ts, ' + ROOT + '/server/src/collectors/registry.ts, ' + ROOT + '/server/src/google.ts and spotify.ts (mirror their OAuth/secret-safety style), ' + ROOT + '/server/src/index.ts (routes already wired to the names you export).',
  'RULES: TS strict; server/mcp = NodeNext ESM with .js import suffixes; NO new npm deps (node builtins + global fetch only); collectors failure-isolated; secrets (tokens/keys) NEVER enter snapshot/SSE/logs. Write ONLY files you own. Final message = raw list of files + concerns.',
  'IMPORTANT owner stance: managing his OWN github from his OWN machine via his OWN gh token on loopback is NOT a security event. Commenting is a normal send button — no confirm-friction, no "are you sure", no rate-paranoia. Keep it quiet, focused, delicate.',
].join('\n')

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
  },
  required: ['files', 'concerns'],
}

phase('Build')

const builders = [
  {
    label: 'build:cursor-usage',
    prompt: [
      COMMON,
      'YOU OWN: server/src/cursor-usage.ts (new) + the cursor entry in server/src/collectors/subs.ts (modify ONLY that service block; leave every other service untouched).',
      'RECON RESULT (verified): cursor-agent CLI stores a valid bearer JWT at ~/.config/cursor/auth.json = {accessToken, refreshToken} (mode 0600). Backend host in ~/.cursor/cli-config.json .serverConfigCache.backendUrl == "https://api2.cursor.sh". Identity in ~/.cursor/cli-config.json .authInfo: userId (numeric, e.g. 79182399) and authId (e.g. github|user_01...).',
      'cursor-usage.ts exports getCursorUsage(): Promise of either { plan, periodStart, periodEnd, totalSpend, limit, percentUsed, breakdown? } OR { error, hint }. Implementation:',
      'PRIMARY: read accessToken fresh each call from ~/.config/cursor/auth.json (token rotates; just re-read). POST {backendUrl}/aiserver.v1.DashboardService/GetCurrentPeriodUsage with headers Authorization: Bearer <accessToken>, Content-Type: application/json, Connect-Protocol-Version: 1, body "{}". Response (Connect JSON): plan_usage { totalSpend, limit, totalPercentUsed, autoSpend, apiSpend } + billing_cycle_start/end (int64 epoch). Map to the return shape (totalPercentUsed -> percentUsed; spends are USD cents per recon — VERIFY by sanity-checking magnitude and divide to dollars).',
      'FALLBACK if the RPC 4xx/5xx (community notes report occasional 400): REST cookie form — GET https://cursor.com/api/auth/stripe and POST https://cursor.com/api/dashboard/get-current-period-usage with Cookie WorkosCursorSessionToken=<authId>::<accessToken> (URL-encode the :: as %3A%3A), body {}. Use whichever returns numbers.',
      'All calls 8s timeout, full try/catch, token never logged/emitted. Cache last-good in module scope so transient failures hold the card. If auth.json missing -> { error, hint: "cursor-agent not logged in" }.',
      'subs.ts cursor block: call getCursorUsage(); on success status "active", plan = plan name, detail = e.g. "$X of $Y this cycle", usage[] = [{ label: "spend", usedPct: percentUsed, resetAt: periodEnd ISO }]; on error keep status "unknown"/"active" with detail = the hint (NOT an error dump). Preserve last-good caching like the other services.',
    ].join('\n'),
  },
  {
    label: 'build:xai-usage',
    prompt: [
      COMMON,
      'YOU OWN: server/src/xai-usage.ts (new), server/src/xai-connect.ts (new, mirrors spotify.ts client-paste pattern), the xai/grok entry in server/src/collectors/subs.ts (modify ONLY that block), and the new routes are ALREADY in index.ts? NO — index.ts does not yet route xai. You must ALSO add minimal routes: edit server/src/index.ts to add POST /api/xai/key (body {key}) -> xaiSetKey, and GET nothing else. Keep edits surgical, follow the existing route style + the Host/Origin guard already present.',
      'RECON RESULT: local ~/.grok/auth.json .key is a grok-cli OAuth access JWT (scope grok-cli:access api:access), short-lived (~6h, auto-refreshed by the CLI), NOT an xai- key, NOT a management key. team_id is a field in that auth.json entry. Two paths:',
      'PATH A (best-effort, zero-config): the grok CLI /usage routes through an internal RPC x.ai/auth/check_subscription via https://cli-chat-proxy.grok.com (bearer = the local .key JWT). Try it: read the entry .key fresh, GET/POST the check_subscription endpoint with Authorization: Bearer <key> (research exact path/verb minimally from the shape; if it 404s, abandon quietly). If it returns tier/subscription/usage, surface that. UNDOCUMENTED — wrap in try/catch, never fatal.',
      'PATH B (reliable, one-time paste — like spotify client id): xai-connect.ts exports xaiSetKey(key: unknown): Promise<void> — validate it looks like an xai management key (non-empty, reasonable length; xai- prefix optional), store {key} 0600 at ~/.config/atrium/xai_mgmt.json atomic. getXaiUsage() reads that key + team_id from ~/.grok/auth.json and calls: GET https://management-api.x.ai/v1/billing/teams/{team_id}/prepaid/balance (Authorization: Bearer <mgmtkey>) -> total.val (USD cents) = prepaid credits; and GET .../postpaid/invoice/preview -> coreInvoice.amountAfterVat (spend), effectiveSpendingLimit. 8s timeouts, try/catch, key never logged.',
      'xai-usage.ts exports getXaiUsage(): Promise of { source: "internal"|"mgmt", credits?, spend?, limit?, tier?, detail } OR { error, hint }. Order: try PATH A; if it yields a usable number use it; else if mgmt key file exists use PATH B; else { error, hint: "paste an x.ai Management API key (console.x.ai -> Settings -> Management Keys) to see credits" }.',
      'subs.ts xai/grok block: call getXaiUsage(); active with usage bar when credits/spend known; when only hint, status active + detail = hint (NOT error dump) + keep the existing session-count detail the block already computes. Preserve last-good caching. Never emit key/jwt.',
      'Also: web side — you do NOT own SubsPanel; the web builder adds the paste UI. Just expose POST /api/xai/key cleanly.',
    ].join('\n'),
  },
  {
    label: 'build:notes-edit',
    prompt: [
      COMMON,
      'YOU OWN: server/src/collectors/notes.ts (ADD writeNote, keep readNote + collector intact) and web/src/panels/NotesPanel.tsx (add edit mode to the existing reader).',
      'writeNote(body: any): Promise<{ ok: true; modifiedAt: string }> — body { path (rel), content (string), baseModifiedAt? (ISO) }. Security: reuse the SAME vault-containment guard readNote uses (resolve within vault root, .md only, reject traversal/symlink-escape, no memory/ dir). Size cap content at 512KB -> reject larger. CONFLICT DETECTION: if baseModifiedAt provided and the file mtime on disk is newer -> throw Error("conflict: file changed on disk since you opened it") (route maps to 409). Write atomically (tmp in same dir + rename) preserving the file; return new mtime ISO. Never create files outside vault; creating a NEW note (path not existing) is allowed ONLY if it resolves inside vault and ends .md.',
      'web/src/api.ts already has fetchNote + NoteContent. ADD (append, do not touch existing): saveNote(relPath, content, baseModifiedAt) -> POST /api/notes/write, returns {modifiedAt}; throws server error message on !ok (special-case 409 -> a typed conflict error the panel can detect).',
      'NotesPanel reader: add an Edit toggle in the reader header. Edit mode = a textarea (mono text-sm, full reader height, glass bg, the raw markdown content) + Save / Cancel. Save calls saveNote with the note baseModifiedAt; on success update the in-view content + modifiedAt + drop back to rendered view + transient "saved"; on 409 conflict show an inline coral bar "changed on disk — reload or overwrite" with a Reload (re-fetch) and Overwrite (save again without baseModifiedAt) choice; on other error inline coral. Unsaved-changes guard: if editing with changes and the user clicks another note or closes, confirm via an inline two-step (arm "discard?"), NOT window.confirm. Keyboard: Cmd/Ctrl+S saves while editing. Keep the dependency-free markdown renderer for view mode. Match DESIGN.md (quiet, mono labels, amber only for attention).',
    ].join('\n'),
  },
  {
    label: 'build:github-detail-ui',
    prompt: [
      COMMON,
      'YOU OWN: server/src/github-detail.ts (new), web/src/components/ItemDetail.tsx (new slide-over), and the WIRING of that slide-over into web/src/App.tsx + web/src/panels/TasksPanel.tsx + web/src/panels/NowView.tsx (open the slide-over instead of jumping to github, while KEEPING the external-link affordance available when the user wants it).',
      'server/github-detail.ts exports githubItemDetail(repo: string, number: string|number): Promise<GithubItemDetail> and githubComment(body: any): Promise<{ok:boolean; comment?:GithubComment; error?:string}>. Use gh CLI (authenticated).',
      'githubItemDetail: validate repo /^[\\w.-]+\\/[\\w.-]+$/ and number integer. One gh api graphql call fetching the issue OR pr (try repository.issueOrPullRequest(number:N) — returns either; select __typename) with: title, body, state, author.login, createdAt, updatedAt, url, labels(first:20).nodes.name, comments(last:40){nodes{id author.login bodyText? body createdAt authorAssociation}}, and on PullRequest: isDraft, merged, reviewDecision, additions, deletions, changedFiles, headRefName, baseRefName, commits(last:1) statusCheckRollup.state, reviews(last:20){nodes{author.login body state createdAt authorAssociation}}. Fold PR reviews into the comments array (kind:"review", reviewState:state) sorted chronologically with issue comments (kind:"comment"). Map to GithubItemDetail exactly. Keep body as markdown (use the markdown body field, not bodyText). 15s timeout.',
      'githubComment: validate repo + number + body (non-empty, <= 60000 chars). Post via gh api: gh api repos/{repo}/issues/{number}/comments -f body=<text> (works for both issues and PRs). Return the created comment mapped to GithubComment. This is a normal action — no extra confirmation server-side. Validate inputs (so a comment never lands on the wrong issue), nothing more.',
      'web/components/ItemDetail.tsx: a right-side SLIDE-OVER (fixed inset-y-0 right-0, w-full max-w-2xl, glass-raised, translate-x transition; backdrop bg-ink/50 click-closes; Escape closes). Props { repo, number, onClose }. On open, fetch /api/github/item. Header: state dot + kind + repo#number (mono) + title; a small external-link icon/link "open on github" (the ONLY place we jump out, and only if the user clicks it — target _blank). Body: rendered markdown of the issue/PR body (REUSE the notes markdown renderer — factor it into web/src/components/markdown.tsx that BOTH NotesPanel and ItemDetail import; you may create markdown.tsx and refactor NotesPanel to import it ONLY IF you coordinate — safer: copy a minimal renderer into ItemDetail to avoid cross-owner edits, OR create markdown.tsx and import it without editing NotesPanel\'s copy). To avoid stepping on the notes builder, CREATE web/src/components/markdown.tsx with the renderer and use it in ItemDetail; do not edit NotesPanel. PR meta row when pr!=null: draft/merged/reviewDecision/ci/+additions/-deletions/changedFiles, headRef->baseRef (mono, tabular-nums). Labels as chips. Comments thread: each comment author + assoc chip + RelTime + rendered markdown body; reviews show reviewState colored (APPROVED jade, CHANGES_REQUESTED coral). A comment composer pinned at the bottom: textarea (markdown) + Send button (calls /api/github/comment, optimistic append on success, transient sending/failed, clears on success) + a tiny "→ eigen" to hand the whole thing to eigen instead. Quiet and focused — this is a reading surface, not a form dump.',
      'api.ts (append, do not touch existing): fetchGithubItem(repo, number) -> GithubItemDetail; postGithubComment(repo, number, body) -> {comment}. ',
      'Wiring: App.tsx holds slide-over state { repo, number } | null and renders <ItemDetail/> when set; passes an openItem(repo, number) callback down to NowView and TasksPanel. In those panels, the task ROW click now opens the slide-over (openItem) instead of being a bare external link; KEEP a hover-cluster "github" external link for when the user explicitly wants the real site. Do not break SendToEigen / quiet / clear clusters already there. Notifications rows: subject may be issue/PR -> open slide-over when the url is an issues/pull url (parse repo+number from it), else external link.',
      'Match DESIGN.md: slide-over is calm glass, mono for ids/meta, amber only for attention, no layout shift, keyboard accessible. The whole point: read + comment WITHOUT leaving atrium, but the door out is always one click away.',
    ].join('\n'),
  },
]

const built = await parallel(builders.map((b) => () => agent(b.prompt, { label: b.label, phase: 'Build', schema: BUILD_SCHEMA })))
log('built ' + built.filter(Boolean).length + '/4')

phase('Compile')

const compile = await agent([
  'Make ' + ROOT + ' build clean and smoke the new endpoints. atrium.service holds port 5599.',
  '1. cd ' + ROOT + ' && npm run build — fix every error (NodeNext .js suffixes, strict TS, tailwind v4, the markdown.tsx import). Do NOT reshape shared/types.ts; no new deps; no tsconfig weakening. Resolve any collision where two builders touched subs.ts or index.ts (merge both intents).',
  '2. systemctl --user stop atrium.service; node server/dist/server/src/index.js & ; sleep 5.',
  '3. Smoke: curl /api/health; /api/snapshot (subs has cursor + xai entries with detail populated, not raw errors); GET "/api/github/item?repo=avifenesh/atrium&number=1" (may 400 if no such item — acceptable; a real one: pull a number from /api/snapshot github.myPRs[0] id "owner/repo#N" and fetch it, expect title+comments); GET "/api/notes/read?path=README.md" still works; POST /api/notes/write with a path you first read (round-trip a harmless append then restore it); POST /api/github/comment with {} expects 400 (validation). Do NOT post a real github comment in smoke.',
  '4. Kill node, verify 5599 free, systemctl --user start atrium.service, confirm is-active.',
  'Iterate until build exits 0 and smoke passes. Output: build status + each smoke result + fixes applied.',
].join('\n'), { label: 'compile-smoke', phase: 'Compile' })
log('compile: ' + String(compile).slice(0, 160))

phase('Review')

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['crit', 'high', 'med', 'low'] },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['file', 'severity', 'problem', 'fix'],
      },
    },
  },
  required: ['findings'],
}

const reviews = await parallel([
  () => agent([
    'Review ' + ROOT + ' new/changed SERVER code (cursor-usage.ts, xai-usage.ts, xai-connect.ts, github-detail.ts, collectors/notes.ts writeNote, collectors/subs.ts, index.ts new routes). Lens: REAL bugs + secret-safety, NOT "managing own github is risky" (owner explicitly rejects that framing — his machine, his token, loopback; commenting needs only input validation so it cannot hit the WRONG issue, nothing more).',
    'Check: tokens/keys (cursor accessToken, xai jwt, mgmt key) never logged/emitted into snapshot/SSE; auth files read fresh, 0600 on writes, atomic; all external calls have timeouts + try/catch and one failure does not blank the subs panel; notes writeNote vault-containment is airtight (traversal, symlink-escape, absolute paths, ..%2f, new-file path still inside vault) and conflict-detect (409) actually compares mtime correctly; github-detail validates repo+number so a comment cannot post to the wrong target; markdown body from github is not executed as html server-side; gh api argv-only (no shell injection via repo/number/body); index.ts new routes keep the Host/Origin guard and return right codes.',
    'Real problems only.',
  ].join('\n'), { label: 'review:server', phase: 'Review', schema: FINDINGS_SCHEMA }),
  () => agent([
    'Review ' + ROOT + ' new/changed WEB code (components/ItemDetail.tsx, components/markdown.tsx, panels/NotesPanel.tsx edit mode, App.tsx + TasksPanel.tsx + NowView.tsx slide-over wiring, api.ts additions) against ' + ROOT + '/DESIGN.md (binding).',
    'Check: the markdown renderer builds REACT ELEMENTS only (NO dangerouslySetInnerHTML), escapes text, link schemes whitelisted http/https/obsidian (no javascript:) — used for BOTH github bodies and notes; slide-over is keyboard accessible (Escape, focus), backdrop closes, no layout shift, calm glass per design; row click opens slide-over but the external "github" door is still one click away (owner wants "without switching unless i want"); notes edit: unsaved-changes guard is inline two-step not window.confirm, Cmd/Ctrl+S works, 409 conflict path offers reload/overwrite, no data loss; comment composer optimistic-append is correct (no dupes, clears on success, failed state recoverable); React correctness (keys, effect cleanup on slide-over unmount, no setState after unmount, types match shared/types.ts GithubItemDetail/GithubComment); serif still confined to wordmark + now hero numerals; everything truncates/min-w-0.',
    'Real problems only.',
  ].join('\n'), { label: 'review:web', phase: 'Review', schema: FINDINGS_SCHEMA }),
])

const findings = reviews.filter(Boolean).flatMap((r) => r.findings)
log('findings: ' + findings.length)

phase('Fix')

if (findings.length > 0) {
  const fix = await agent([
    'Apply review fixes to ' + ROOT + '. Verify each finding against the code first; skip wrong ones with a reason. Do NOT add confirm-friction to github commenting (owner rejected it) — only fix real bugs.',
    JSON.stringify(findings, null, 1),
    'Smallest correct fixes; no shape changes to shared/types.ts. Then npm run build exits 0; stop atrium.service; foreground smoke (health + snapshot subs cursor/xai + github item fetch of a real myPRs number + notes write round-trip); kill; start atrium.service; confirm is-active. Output per-finding fixed/skipped + final status.',
  ].join('\n'), { label: 'fix', phase: 'Fix' })
  return { recipes: 'cursor=local-token, xai=internal+mgmt-paste', findings, fix: String(fix).slice(0, 2500) }
}
return { findings: [], fix: 'none' }
