import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSystemdServiceStatus, parseSystemdServiceStatuses } from './collectors/schedule.js';

test('systemd service status parses a completed success', () => {
  const status = parseSystemdServiceStatus([
    'Result=success',
    'ExecMainStatus=0',
    'ExecMainExitTimestamp=Fri 2026-08-14 22:27:54 IDT',
    'ActiveState=inactive',
    'SubState=dead',
  ].join('\n'));
  assert.deepEqual(status, {
    result: 'success',
    exitStatus: 0,
    exitTimestamp: 'Fri 2026-08-14 22:27:54 IDT',
    activeState: 'inactive',
    subState: 'dead',
  });
});

test('systemd service status preserves failure details', () => {
  const status = parseSystemdServiceStatus([
    'Result=exit-code',
    'ExecMainStatus=1',
    'ExecMainExitTimestamp=Fri 2026-08-14 12:34:56 IDT',
    'ActiveState=failed',
    'SubState=failed',
  ].join('\n'));
  assert.equal(status.result, 'exit-code');
  assert.equal(status.exitStatus, 1);
  assert.equal(status.exitTimestamp, 'Fri 2026-08-14 12:34:56 IDT');
  assert.equal(status.activeState, 'failed');
});

test('systemd service status treats a never-run unit as unknown', () => {
  const status = parseSystemdServiceStatus([
    'Result=success',
    'ExecMainStatus=0',
    'ExecMainExitTimestamp=',
    'ActiveState=inactive',
    'SubState=dead',
  ].join('\n'));
  assert.equal(status.exitTimestamp, null);
});

test('systemd service status parses repeated multi-unit blocks', () => {
  const statuses = parseSystemdServiceStatuses([
    'Id=first.service',
    'Result=success',
    'ExecMainStatus=0',
    'ExecMainExitTimestamp=Fri 2026-08-14 22:00:00 IDT',
    '',
    'Id=second.service',
    'Result=exit-code',
    'ExecMainStatus=1',
    'ExecMainExitTimestamp=Fri 2026-08-14 22:01:00 IDT',
  ].join('\n'));
  assert.equal(statuses.get('first.service')?.result, 'success');
  assert.equal(statuses.get('second.service')?.result, 'exit-code');
  assert.equal(statuses.get('second.service')?.exitStatus, 1);
});
