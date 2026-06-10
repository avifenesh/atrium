export const meta = {
  name: 'atrium-v3',
  description: 'cursor+xai usage recon, notes editing, in-app github read/comment slide-over',
  phases: [
    { title: 'Recon', detail: 'find real cursor + x.ai usage sources' },
    { title: 'Build', detail: 'usage collectors, notes write, github detail + slide-over UI' },
    { title: 'Compile', detail: 'build + endpoint smoke' },
    { title: 'Review', detail: 'security + design conformance' },
    { title: 'Fix', detail: 'apply findings' },
  ],
}

const ROOT = '/home/avifenesh/projects/atrium'

phase('Recon')

const RECON_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    summary: { type: 'string' },
    method: { type: 'string', description: 'EXACT how to get the usage: endpoint URL, auth header derivation, file path, response field path. Concrete enough to implement.' },
    caveats: { type: 'string' },
  },
  required: ['found', 'summary', 'method', 'caveats'],
}

const recon = await parallel([
  () => agent([
    'Investigate whether Cursor exposes account USAGE/quota that atrium (life dashboard for avifenesh) can read locally. Be exhaustive and CONCRETE.',
    'On-disk: ~/.cursor/ (cli-config.json has model/permissions only — already checked), ~/.config/Cursor/, ~/.local/share/cursor-agent/, look for any access token / session / api key / usage cache (sqlite, json, leveldb). Run: ls -la and find under those dirs; grep for token/jwt/usage/quota/billing in json files (NAMES not values).',
    'Cursor desktop app stores a session token (WorkosCursorSessionToken) — find where the cursor-agent CLI keeps its auth (it logs in as aviarchi1994@gmail.com). If a bearer/JWT exists locally, the dashboard could call cursor.com/api endpoints.',
    'Web API: research (WebSearch/WebFetch) the endpoints the Cursor dashboard itself calls for usage — known candidates: GET https://cursor.com/api/usage?user=... , https://cursor.com/api/auth/me , https://www.cursor.com/api/dashboard/... — find the REAL ones and what auth they need (cookie WorkosCursorSessionToken vs Bearer). Note 2025/2026 changes (Composer pricing, request-based usage).',
    'GOAL: a concrete recipe atrium can implement: token source on disk -> exact endpoint -> response field = usage numbers. If genuinely impossible locally, say so with proof (what you checked).',
    'Do NOT print secret values. Read-only.',
  ].join('\n'), { label: 'recon:cursor', phase: 'Recon', schema: RECON_SCHEMA }),

  () => agent([
    'Investigate whether x.ai / Grok exposes account USAGE/credits/quota that atrium can read using avifenesh local creds. Concrete.',
    'On-disk: ~/.grok/auth.json holds an OAuth entry keyed https://auth.x.ai::<uuid> with fields: key (api key?), auth_mode, user_id, team_id, refresh_token, expires_at. Inspect the full structure (field NAMES + value SHAPES, not secrets). Is .key a usable x.ai API key (xai-...)? Check ~/.grok/ fully (config.toml, sessions/).',
    'x.ai API: research the management/usage endpoints. Known: https://api.x.ai/v1 (OpenAI-compat, needs xai- key); https://management-api.x.ai/ (api key mgmt). Find any endpoint returning credits/spend/usage for either an api key OR the oauth token. Check console.x.ai network calls if documented. team_id present — is there a billing/usage endpoint scoped to team?',
    'If .key is an xai- API key: can we GET something like https://api.x.ai/v1/api-key (returns key info/limits) or a usage endpoint? Test conceptually from docs.',
    'GOAL: concrete recipe — which local field is the credential, exact endpoint, response field = usage/credits. If impossible, prove it.',
    'Do NOT print secret values. Read-only.',
  ].join('\n'), { label: 'recon:xai', phase: 'Recon', schema: RECON_SCHEMA }),
])

log('recon cursor.found=' + (recon[0] && recon[0].found) + ' xai.found=' + (recon[1] && recon[1].found))

return { recon }
