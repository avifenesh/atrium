import { useState } from 'react';

export default function WikiPanel() {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="min-w-0">
      <header className="mb-4 flex items-end justify-between gap-4 border-b pb-4 hairline">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.15em] text-mist-faint">knowledge map</div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-mist">LLM Wiki</h1>
          <p className="mt-1 text-sm text-mist-dim">Projects, techniques, sources, and the links between them.</p>
        </div>
        <a className="shrink-0 text-sm text-slate-glow hover:text-mist" href="/workspace/wiki" target="_blank" rel="noreferrer">
          Open canvas ↗
        </a>
      </header>
      <div className="wiki-frame-wrap">
        {!loaded && <div className="absolute inset-0 grid place-items-center text-sm text-mist-faint">Building the map…</div>}
        <iframe className="wiki-frame" src="/workspace/wiki" title="LLM Wiki knowledge graph" onLoad={() => setLoaded(true)} />
      </div>
    </div>
  );
}
