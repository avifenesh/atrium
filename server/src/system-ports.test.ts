import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBind, parsePortBody, scopeDetail, widerScope } from './system-ports.js';

test('classifyBind distinguishes loopback, tailnet, wg-trace, and LAN', () => {
  assert.equal(classifyBind('127.0.0.1'), 'loopback');
  assert.equal(classifyBind('[::1]'), 'loopback');
  assert.equal(classifyBind('localhost'), 'loopback');
  assert.equal(classifyBind('100.64.12.3'), 'tailnet');
  assert.equal(classifyBind('[fd7a:115c:a1e0::1]'), 'tailnet');
  assert.equal(classifyBind('10.203.0.2'), 'wg');
  assert.equal(classifyBind('0.0.0.0'), 'lan');
  assert.equal(classifyBind('[::]'), 'lan');
  assert.equal(classifyBind('*'), 'lan');
  assert.equal(classifyBind('192.168.1.4'), 'lan');
});

test('widerScope keeps the most exposed bind', () => {
  assert.equal(widerScope('loopback', 'lan'), 'lan');
  assert.equal(widerScope('tailnet', 'wg'), 'tailnet');
  assert.equal(widerScope('lan', 'tailnet'), 'lan');
});

test('scopeDetail never claims every interface for a tailnet bind', () => {
  assert.match(scopeDetail('tailnet'), /tailnet/);
  assert.doesNotMatch(scopeDetail('tailnet'), /every/);
  assert.match(scopeDetail('lan'), /LAN/);
});

test('parsePortBody rejects bad ports', () => {
  assert.throws(() => parsePortBody({}), /port must be/);
  assert.throws(() => parsePortBody({ port: 0 }), /port must be/);
  assert.deepEqual(parsePortBody({ port: 4173 }), { port: 4173, label: null });
  assert.deepEqual(parsePortBody({ port: 4173, label: '  vite  ' }), { port: 4173, label: 'vite' });
});
