#!/usr/bin/env node
// Idempotently registers atrium with eigen: mcp.json server entry + atrium-ops skill.
// Preserves all existing servers (e.g. 'workspace') — only the 'atrium' entry is touched.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = homedir();
const mcpPath = join(home, '.eigen', 'mcp.json');

// derive both paths from the runtime instead of hardcoding: the node that ran this
// script, and the mcp entrypoint relative to this script's own location (scripts/ → ../mcp/…)
const scriptDir = dirname(fileURLToPath(import.meta.url));
const mcpEntrypoint = join(scriptDir, '..', 'mcp', 'dist', 'mcp', 'src', 'index.js');

const entry = {
  name: 'atrium',
  command: [process.execPath, mcpEntrypoint],
  // no tools allowlist = all atrium_* tools exposed
};

let cfg = { servers: [] };
if (existsSync(mcpPath)) {
  cfg = JSON.parse(readFileSync(mcpPath, 'utf8'));
  if (!Array.isArray(cfg.servers)) cfg.servers = [];
}

const idx = cfg.servers.findIndex((s) => s && s.name === 'atrium');
let mcpChange;
if (idx === -1) {
  cfg.servers.push(entry);
  mcpChange = 'added';
} else if (JSON.stringify(cfg.servers[idx]) === JSON.stringify(entry)) {
  mcpChange = 'unchanged';
} else {
  cfg.servers[idx] = entry;
  mcpChange = 'replaced';
}

mkdirSync(dirname(mcpPath), { recursive: true });
writeFileSync(mcpPath, JSON.stringify(cfg, null, 2) + '\n');
console.log(`${mcpPath}: 'atrium' server ${mcpChange} (${cfg.servers.length} servers total)`);

const skillSrc = join(dirname(fileURLToPath(import.meta.url)), 'eigen-skill.md');
const skillDir = join(home, '.eigen', 'skills', 'atrium-ops');
const skillDest = join(skillDir, 'SKILL.md');
const body = readFileSync(skillSrc, 'utf8');
const skillChange =
  !existsSync(skillDest) ? 'written'
  : readFileSync(skillDest, 'utf8') === body ? 'unchanged'
  : 'updated';
mkdirSync(skillDir, { recursive: true });
writeFileSync(skillDest, body);
console.log(`${skillDest}: ${skillChange}`);
