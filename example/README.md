# langsys-js-server example

A minimal SvelteKit app (adapter-node) demonstrating server-side translation, and the
fixture the repo's acceptance tests run against.

**Not published to npm** — `package.json`'s `files` field keeps it out of the tarball.

## Run it

```bash
npm install
npm run build

# terminal 1 — the mock Langsys API
npm run mock-api

# terminal 2 — the built app
PORT=5570 ORIGIN=http://localhost:5570 node build/index.js
```

Then compare, and note that **`view-source` is the only place the difference shows**:

```bash
curl -s http://localhost:5570/    | grep '<h1'   # Hydration begins with better water.
curl -s http://localhost:5570/it  | grep '<h1'   # L'idratazione inizia con un'acqua migliore.
curl -s http://localhost:5570/ru  | grep bottles # 3 бутылки  (the Russian FEW form)
```

## Why there is a mock API

The example runs offline and deterministically. A test that depends on a live translation
backend measures the network as much as the package, and a flaky acceptance test gets
muted — which is worse than not having one.

`mock-api/server.mjs` speaks the real API shape (verified against
`langsys-js-typescript@0.6.5` `dist/index.mjs:88-133`) and adds a small test-control
surface so assertions can be made on facts rather than inferred from logs:

| Endpoint | Purpose |
|---|---|
| `GET /__test__/registered` | everything POSTed to `translatable-items` |
| `GET /__test__/fetch-counts` | catalog fetches per locale — proves caching and single-flight |
| `GET /__test__/reset` | clear both |
| `GET /__test__/key-type?value=read` | flip the key type, to exercise the harvest refusal |
| `GET /__test__/latency?ms=150` | add upstream latency, to force renders to interleave |

## What to look at

**`src/hooks.server.ts`** is the entire integration, and the placement of `run()` is the
part worth reading. It wraps `resolve(event)` — the whole render, including every `load`
function.

That is not a style choice. `load` runs *before* layout components, and `load` is exactly
where `<title>`, meta and OG copy are built — the indexed strings this package exists for.
A `run()` in a root layout would leave all of them outside the scope, rendering base
language. And because `t()` outside a scope does not throw — it returns the base phrase
and warns once — a too-narrow `run()` fails **quietly** in production and looks perfect in
the base locale.

**`src/routes/[[locale]]/+page.server.ts`** calls `t()` from a `load` function, with no
component context anywhere in sight. That is the case that makes `AsyncLocalStorage` a
requirement rather than a convenience: Svelte context, Vue `provide` and React context
cannot reach a `load` function.

**`ru` renders `3 бутылки`** — the Russian *few* form. Russian has four plural categories;
a flat template renders perfectly in English and wrongly in Russian, which is why this is
asserted rather than eyeballed.

## The tests it backs

`tests/e2e/example.test.ts` in the parent repo boots this app's **built adapter-node
output** (not the dev server — the defect this package fixes was a production-build one)
and asserts SPEC §13's definition of done:

| § | Assertion |
|---|---|
| 13.1 | a crawler fetching `/it` receives Italian body copy in the served bytes |
| 13.2 | plurals correct in a language with more than two forms |
| 13.3 | 120 interleaved requests across four locales never cross-contaminate |
| 13.4 | harvesting registers phrases without entering the TTFB path |

Every assertion carries a negative control — `/it` must contain Italian **and must not
contain the English**, because "contains Italian" alone would pass on a page emitting
both.

**The suite is mutation-tested against the original defect.** Removing the `langsys.run()`
wrapper from `hooks.server.ts` — reproducing exactly the bug this package exists to fix —
fails five tests including the §13.1 acceptance test. The base-locale control keeps
passing, correctly, since English renders English either way.

## What this example does NOT show

`<Phrase>` and `<Translate>` are not translated server-side in 0.1.0 — see the capability
matrix in the parent README. They need per-framework child-capture adapters and land in
0.2.0. Nothing here uses them, so the example is not quietly demonstrating a capability
the package does not have.
