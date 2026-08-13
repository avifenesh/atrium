#!/usr/bin/env node
// Idempotently registers atrium with Grok: [mcp_servers.atrium] in ~/.grok/config.toml.
// Only that table is touched. Other MCP servers stay as they are.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = homedir();
const configPath = join(home, '.grok', 'config.toml');
const scriptDir = dirname(fileURLToPath(import.meta.url));
const mcpEntrypoint = join(scriptDir, '..', 'mcp', 'dist', 'mcp', 'src', 'index.js');

const table = `[mcp_servers.atrium]
command = ${tomlString(process.execPath)}
args = [${tomlString(mcpEntrypoint)}]
enabled = true
`;

function tomlString(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

let src = '';
if (existsSync(configPath)) src = readFileSync(configPath, 'utf8');

const header = '[mcp_servers.atrium]';
const start = src.indexOf(header);
let next = src;
let change;
if (start === -1) {
  next = `${src.replace(/\s*$/, '')}\n\n${table}`;
  change = 'added';
} else {
  const rest = src.slice(start + header.length);
  const rel = rest.search(/\n\[/);
  const end = rel === -1 ? src.length : start + header.length + rel;
  const current = src.slice(start, end).trimEnd() + '\n';
  if (current === table) {
    change = 'unchanged';
  } else {
    next = `${src.slice(0, start)}${table}${src.slice(end).replace(/^\n/, '')}`;
    change = 'replaced';
  }
}

if (change !== 'unchanged') {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, next.endsWith('\n') ? next : `${next}\n`);
}
console.log(`${configPath}: 'atrium' MCP server ${change}`);
