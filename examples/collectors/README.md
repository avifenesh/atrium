# Example collectors

Standalone, dependency-free collector templates. **None of these are wired in** — they are
starting points you copy into `server/src/collectors/`, adjust, and register in
`server/src/index.ts`. The full contract is in [../../docs/collectors.md](../../docs/collectors.md).

| file | shape it teaches |
| --- | --- |
| [`disk-usage.ts`](disk-usage.ts) | shell out to a subprocess (`df`), build tinted rows, raise a crit flag on a threshold |
| [`http-service.ts`](http-service.ts) | poll a local HTTP daemon: liveness check, read a metrics endpoint, warn flag while down |

Both write the generic `extra` lane via `store.setExtra()`, so they render in the dashboard
with **no React code**. The import paths inside each file are written for the destination
(`server/src/collectors/`), so a plain copy compiles as-is.

## Using one

```sh
cp examples/collectors/http-service.ts server/src/collectors/
```

Then in `server/src/index.ts`:

```ts
import serviceCollector from './collectors/http-service.js';
// add to the register() loop:
for (const c of [ /* …existing… */, serviceCollector ]) register(c);
```

```sh
npm run build
```

It shows up as a new view in the rail automatically.
