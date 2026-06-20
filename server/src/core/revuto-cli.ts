import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { sh, userSystemdEnv } from '../util.js';

const REVUTO_ENV = {
  ...process.env,
  REVUTO_CONFIG: join(config.paths.revutoVault, 'revuto.config.json'),
  REVUTO_VAULT: config.paths.revutoVault,
};

export function revutoCommand(): { cmd: string; argsPrefix: string[] } {
  if (existsSync(config.paths.revutoCli)) return { cmd: config.paths.revutoCli, argsPrefix: [] };
  return {
    cmd: process.execPath,
    argsPrefix: [join(config.paths.revutoRepo, 'dist', 'daemon', 'src', 'cli.js')],
  };
}

export async function runRevutoCli(args: string[], timeoutMs = 660_000): Promise<string> {
  const command = revutoCommand();
  return await sh(command.cmd, [...command.argsPrefix, ...args], { timeoutMs, env: REVUTO_ENV });
}

export function systemctlUser(verb: 'start' | 'stop' | 'restart' | 'show', unit: string, extraArgs: string[] = []): Promise<string> {
  return sh('systemctl', ['--user', verb, unit, ...extraArgs], { timeoutMs: 30_000, env: userSystemdEnv() });
}

export async function restartRevutoDaemon(): Promise<void> {
  await systemctlUser('restart', 'revuto.service');
}
