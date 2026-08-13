#!/usr/bin/env node

const API = process.env.ATRIUM_URL || 'http://127.0.0.1:5599';

async function request(path, init) {
  const res = await fetch(`${API}${path}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `${path} returned ${res.status}`);
  return body;
}

function usage() {
  console.log(`atrium-reentry

  park [note] [--title text] [--energy light|medium|deep]
  list
  scan
  resume <id-or-prefix>
  done <id-or-prefix>`);
}

async function resolveId(value) {
  if (!value) throw new Error('context id or prefix is required');
  const snapshot = await request('/api/snapshot');
  const matches = snapshot.reentry.contexts.filter((item) => item.id === value || item.id.startsWith(value));
  if (matches.length !== 1) throw new Error(matches.length ? `ambiguous id prefix: ${value}` : `unknown context: ${value}`);
  return matches[0].id;
}

const [command = 'help', ...argv] = process.argv.slice(2);

try {
  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
  } else if (command === 'park') {
    let title = '';
    let energy = 'medium';
    const note = [];
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--title') title = argv[++i] || '';
      else if (argv[i] === '--energy') energy = argv[++i] || '';
      else note.push(argv[i]);
    }
    if (!['light', 'medium', 'deep'].includes(energy)) throw new Error('energy must be light, medium, or deep');
    const context = await request('/api/reentry/park', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: process.cwd(), title, note: note.join(' '), energy }),
    });
    console.log(`${context.id.slice(0, 8)}  parked  ${context.title}`);
    await request('/api/reentry/scan', { method: 'POST' }).catch((err) => {
      console.error(`parked, but status preparation did not start: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
  } else if (command === 'list') {
    const snapshot = await request('/api/snapshot');
    const contexts = snapshot.reentry.contexts.filter((item) => item.state !== 'done');
    if (!contexts.length) console.log('No parked contexts.');
    for (const item of contexts) {
      const next = item.capsule?.nextAction ? `\n          next: ${item.capsule.nextAction}` : '';
      console.log(`${item.id.slice(0, 8)}  ${item.state.padEnd(7)} ${item.title}\n          ${item.path}${next}`);
    }
  } else if (command === 'scan') {
    await request('/api/reentry/scan', { method: 'POST' });
    console.log('Re-entry scan queued.');
  } else if (command === 'resume' || command === 'done') {
    const id = await resolveId(argv[0]);
    const action = command === 'done' ? 'archive' : 'resume';
    const result = await request(`/api/reentry/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    console.log(command === 'done' ? `done  ${result.title}` : `opened via ${result.via}`);
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
