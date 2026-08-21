# langsys-js-server — build specification

**Status:** draft for review. **Audience:** the agent that will build this SDK.

This document is the build guide. It is written to be read once, top to bottom, by someone
who has not been part of the conversation that produced it.

**Provenance markers are load-bearing in this document.** Every claim is tagged:

- **[VERIFIED]** — checked against a published artifact at a pinned version, by execution
  where execution was possible. Cite the artifact and line.
- **[PROPOSED]** — a design decision made here, not yet validated. Argue with it.
- **[OPEN]** — a question this spec cannot answer. Do not guess; resolve it before building
  the affected part.

Do not promote a **[PROPOSED]** to settled by implementing it. Do not treat an **[OPEN]** as
answered because a plausible answer is nearby. This project has a documented failure class —
see [§10](#10-how-this-project-verifies-things) — in which a check that produces no signal
reads as a pass, and it has bitten every participant in this design at least once.

---

## 1. Why this package exists

### The problem, measured

A production SvelteKit deployment (`affsite-platform`: 8 affiliate sites, ~20 locales,
`adapter-node` behind a PHP proxy, PM2 `instances: 2`) measured its own production HTML on a
page serving Italian: **5,031 characters of visible SSR body text, 100% English**, with the
full Italian catalog shipped inside a 133 KB inline hydration script. **[VERIFIED]** — a byte
count from a running site, not a reasoned claim.

Worst of both: you pay to ship the catalog and still render the base language.

### Why the client SDKs cannot fix this

In `langsys-js-react`, `-vue` and `-svelte`, the catalog lives in **module-global signals**
that only `LangsysApp.init()` writes, and `init()` runs in a client-only lifecycle hook
(`useEffect` / `onMounted` / `onMount`). None of those execute during server rendering, so
`t()`, `$t`, `<Phrase>` and `<Translate>` all render the base language into server HTML.

Moving `init()` to the server does not fix it — it breaks worse. **[VERIFIED]** against
`langsys-js-typescript@0.6.5`:

| Fact | Evidence |
|---|---|
| `LangsysApp` is a hard module singleton | `dist/index.mjs:991` — `var LangsysApp = new LangsysAppClass()` |
| Catalog state is module-global | `:255-256` — `sTranslations`, `currentlyLoadedLocale` |
| A per-request instance is **not** isolated | `:409-410` — `Translations`' own constructor subscribes to those globals |

Under a long-lived server one process serves every concurrent request, so seeding those
globals server-side is a cross-request data race: an in-flight `/de` render can observe
`/it`'s catalog. The race needs an `await` between write and read, which every async `load`
function provides. **It is therefore load-dependent and cannot reproduce in development with
one user.**

The precise statement is not "the singleton is a bug" — it is **there is no request-scoped
translator in the SDK.** A non-singleton class with module-global state races identically.

### Why this is a separate package, not a patch

Module-global catalog state is the *correct* design for a browser: one user, one locale, free
reactivity across the whole tree with no prop-drilling. The `persist()` wiring to
`localStorage` confirms browser-first intent. This is a browser-shaped architecture meeting a
server, not sloppiness.

The two runtimes want opposed designs:

| | Client SDKs | This package |
|---|---|---|
| State scope | module-global, ambient | **request-scoped, always** |
| Persistence | `localStorage` | none |
| Concurrency | one user | many, interleaved |
| Render target | DOM | string / stream |
| Harvest timing | batched, in-session | **fire-and-forget, after response** |

Consequences of splitting rather than retrofitting:

- `node:async_hooks` never enters a browser bundle — no externals config, no Workers compat
  flags, no dead code for client consumers.
- No regression risk to four shipping packages whose hottest path would otherwise be touched.
- The client SDKs' server-side surface becomes honestly nameable: **preload and hand off**,
  not "SSR translation". A claim that cannot be stated cannot be misread.
- It enables a deployment that is currently impossible in JS: a marketing site using **only**
  this package — no hydration, no seeding, no client bundle, fully translated crawlable HTML.

### The family model

```
server family     langsys-php   ·   langsys-js-server      <- renders translated HTML
client family     langsys-js-typescript / -react / -vue / -svelte
                                                            <- renders translated DOM
interop           the marker protocol (§4)
```

**`langsys-php` is the reference implementation.** It already does this job: renders,
walks the HTML server-side, substitutes, sends. This package is its Node sibling and should
conform to it rather than invent a parallel model. Where the two disagree, PHP is presumed
correct until shown otherwise — it has years of production behind it.

---

## 2. Scope

### In scope

1. Request-scoped catalog resolution for `t()` and the three primitives during server render.
2. Server-side translation of `<Phrase>` (markup-bearing sentence, kept whole) and
   `<Translate>` (block, split per text node), preserving plurals and interpolation.
3. Emission of the marker attributes the client SDKs and PHP already recognise (§4).
4. Fire-and-forget harvesting of missing phrases, never in the TTFB path (§6).
5. A hand-off contract so a client SDK hydrating over this output does not re-translate or
   re-register (§7).

### Explicitly out of scope

- **Replacing the client SDKs.** An app with client-side locale switching still needs one.
- **A second user-facing translator API.** If integrators must choose per call site between
  two translators, this package has failed. See §3.4.
- **Catalog files.** The phrase is the key. There is no extract step and no `locales/*.json`.
  Anyone reaching for one has misunderstood the product.
- **Machine translation.** Draft generation belongs to the Translation Manager.

### Non-goal worth stating explicitly

**This package must not become the way people do i18n in Node generally.** Its reason to
exist is crawler-visible translated body copy in non-base locales. Every feature should be
justified against that sentence.

---

## 3. Architecture

### 3.1 Request-scoped resolution is the foundation

Everything else depends on this. **[PROPOSED]**

Use `AsyncLocalStorage` (Node ≥16, Deno, Bun, Cloudflare Workers with `nodejs_compat`).
Ambient scoping is a requirement, not a convenience: `t()` is legitimately called from
`load` functions and plain utility modules that have no component context, so framework
context (Svelte context, Vue `provide`, React context) cannot cover the surface alone.

A useful **[VERIFIED]** detail about the base SDK's shape: every read funnels through
`buildTFn`, whose entire dependency is `sTranslations.get()` and `currentlyLoadedLocale.get()`.
If the base SDK ever wanted request-awareness, the blast radius is those two accessors. This
package should not depend on that happening — but the tokenization and id functions it *will*
depend on are already pure, which is the property that makes an independent implementation
viable at all.

Per-request context carries at minimum:

```
{ locale, catalog, missQueue, projectId, keyType }
```

**No module-level mutable state.** Not for the catalog, not for the miss queue, not for a
"current locale". If a value differs between two concurrent requests, it lives in the context.
A shared *immutable* cache of fetched catalogs keyed by locale is fine and expected (§8).

### 3.2 The three primitives, server-side

The primitive distinction is the product. A design that collapses them is wrong even if the
output looks right in the base language.

| Primitive | What it is | Server handling |
|---|---|---|
| `t(phrase, category?, params?)` | plain string | Direct catalog lookup + `interpolate`. No markers needed — it is a function call, it knows its phrase, and it returns a string. |
| `<Phrase>` | **one markup-bearing sentence, kept whole** | Resolve as a single catalog entry; render its markup tokens back in. Emit `data-ls-phrase` so no walker re-splits it. |
| `<Translate>` | a block, split per text node | Tokenize **its own subtree only**, compute `custom_id`, look up per token. |

**Why `<Phrase>` must stay whole** — this is the grammatical-agreement argument the whole
product rests on. A count and the noun it inflects must be in one catalog entry: Russian has
4 plural categories, Arabic 6, Polish 4. Splitting `Based on {n} <strong>reviews</strong>`
into fragments makes correct translation impossible in those languages, and the base language
still looks perfect.

### 3.3 `<Translate>` tokenizes its own subtree — not the page

**[PROPOSED]** and it is the central design decision in this document.

The tempting shortcut is PHP's `translatePage($html)`: render the page, walk the finished
HTML, substitute. **Do not do this for the JS path.** An opaque whole-page walk is equivalent
to treating the entire page as one content block: it discards the primitive distinctions at
the boundary and loses plurals and variables with them. PHP gets away with it because PHP's
author-facing model *is* markup-first; this package's callers write components.

Instead: each `<Translate>` renders its own children to a string, tokenizes **that string**,
computes the same `custom_id` via the existing pure function, and looks up per token. Scope
is exactly the primitive that declared itself a block. A `<Phrase>` inside it is skipped via
the marker, as today.

**[OPEN]** Whether Svelte 5, React and Vue can each render a child tree to a string *at render
time* rather than after mount, and what that costs. Svelte 5 snippets, React `children` under
RSC, and Vue slots differ materially here. Resolve per framework before committing.

### 3.4 One translator, not two

An interim workaround exists and is currently prescribed by `langsys-skill`: a hand-rolled
pure lookup over the server-fetched catalog, used for `<title>`, meta and OG fields. It works,
and the reference deployment runs it in production.

**It is not the model to build on.** It covers plain strings only — no `<Phrase>`, no
`<Translate>` — so the moment indexed copy contains an `<em>` or an inflected count you are
back to base language. And it forces a per-call-site choice between two translators, where
both wrong choices fail silently: the reactive one renders base language into server HTML
(invisible except in view-source), and the pure one renders correctly and then goes stale.

For reference, the corrected shape of that interim helper, which mirrors the SDK's own
`buildTFn` minus harvesting **[VERIFIED]** against `0.6.5`:

```ts
import { interpolate } from 'langsys-js-typescript';   // public and pure — d.ts:852

const makeCatalogT = (catalog, locale) => (phrase, ...rest) => {
    const category = typeof rest[0] === 'string' ? rest[0] : '';
    const params   = typeof rest[0] === 'object' ? rest[0] : rest[1];
    const value    = catalog?.[category || '__uncategorized__']?.[phrase];
    // A content block is an OBJECT — `|| phrase` does not fall back correctly.
    const translated = typeof value === 'string' && value.length > 0 ? value : phrase;
    return params ? interpolate(translated, params, locale) : translated;
};
```

Two traps that version encodes, both **[VERIFIED]** and both worth carrying forward into this
package's implementation:

- Omitting `interpolate` renders the literal `Hello {name}` server-side and correctly
  client-side — a hydration mismatch on precisely the strings carrying data
  (`dist/index.mjs:144`).
- `|| phrase` does not guard the object case; the SDK checks
  `typeof value === 'string' && value.length > 0` (`:136`).

---

## 4. The marker protocol — a cross-SDK contract

**[VERIFIED]** against `langsys-js-typescript@0.6.5` `dist/index.d.ts`. This is not new
surface being invented here; it already exists and already spans two SDKs.

| Marker | Meaning | Set by |
|---|---|---|
| `data-ls-phrase` | subtree is a self-managed keep-together phrase | JS `<Phrase>` components |
| `data-langsys-phrase` | same | `langsys-php`'s author-facing marker |
| `translate="no"` | opt out entirely, subtree skipped | HTML standard |
| `data-notrans` | same | PHP alias, for hosts that strip unknown bare attributes |

Presence means intent, like any boolean HTML attribute — but an explicit `="false"` or `="0"`
opts **out** of the opt-out, compared after trimming.

The SDK's own documentation states the reason both spellings are recognised, and it is
precisely this package's situation:

> "on SSR handoff there is only ONE DOM: a page rendered by PHP and then hydrated by a JS SDK
> is walked by both implementations, so this tokenizer has to recognise PHP's marker or it
> re-tokenizes a subtree PHP deliberately kept whole."

`isPhraseMarked()` and `isTranslationExcluded()` are mirrored **byte-for-byte** against
`langsys-php`'s methods of the same names, deliberately, so the correspondence is checkable at
a glance. **This package makes it three implementations.** Mirror exactly; if you find a wart,
flag it to the owner rather than tidying it. The SDK's own comment on a past divergence:

> "Divergence-by-tidying is the same failure class as divergence-by-oversight, just better
> intentioned."

---

## 5. Tokenizer parity — the primary risk

**Read this section before writing any tokenizer code.**

`<Translate>` blocks are identified by `generateCustomId(category, tokens)`, a pure function.
If this package's tokenizer produces even one token differently from the DOM walker or from
PHP, the same block registers under two ids. The symptom is **silent catalog fragmentation**:
translators see duplicate blocks, half the app resolves and half falls back, and nothing
errors. It surfaces weeks later as "some pages aren't translated".

This is not hypothetical. `generateLegacyCustomId` exists in the published SDK today because
an id-generation change orphaned existing catalogs and needed a permanent lookup-only
fallback. Its doc comment carries the general lesson **[VERIFIED]**:

> the collision is a property of the FINAL hashed string, not the phrase: `JSON.stringify`
> shifts every character's offset, so the same phrase pair can collide standalone and not
> collide here — and changing `category` moves every character into different lanes.

### Required: a shared conformance fixture set

**[PROPOSED]**, and the single most important recommendation in this document.

Today the correspondence between PHP and JS is maintained by mirroring code and reading
carefully. That works until it doesn't, and **no test fails when it stops.** Adding a third
implementation without a conformance suite is how the fragmentation above becomes inevitable
rather than possible.

The suite should be: **HTML in → `tokens[]` and `custom_id` out**, held in a shared location,
run in CI by `langsys-php`, `langsys-js-typescript` and this package. Minimum coverage:

- nested markup, mixed inline and block elements
- a `<Phrase>` nested inside a `<Translate>`
- `translate="no"` and `data-notrans` subtrees, including the `="false"` opt-out-of-opt-out
- tokens containing hyphens (`e-mail`) — the case that motivated the `JSON.stringify` fix
- whitespace-only text nodes, leading/trailing whitespace, `&nbsp;`
- self-closing and void elements
- attributes carrying translatable values (§9)
- identical content under different categories, asserting the ids differ

Fixtures must be authored so that a wrong implementation *fails*, not merely so a right one
passes. An implementation is not conformant because it produced no diff — see §10.

---

## 6. Harvesting

Runtime phrase discovery is the core product mechanic — the phrase is the key, and phrases are
discovered from the running app. A server SDK that does not harvest means the strings most
worth translating (indexed body copy, titles, meta) are the ones that never self-register.
That is backwards, so **harvesting is in scope.** **[PROPOSED]**

Requirements:

1. **Request-scoped queue.** A module-global flush queue would reintroduce exactly the
   cross-request coupling this package exists to avoid.
2. **Never in the TTFB path.** Drain after the response has flushed — `setImmediate` /
   `queueMicrotask` after send on Node, `waitUntil` on edge runtimes. A translation backend
   being slow must never make the site slow.
3. **Fire-and-forget, but not silent.** Failures do not propagate to the request, and they do
   not vanish either: log them. See §10 on checks that produce no signal.
4. **Deduplicate before sending.** A page rendering the same missing phrase 50 times must post
   it once.
5. **Write key only.** Harvesting requires a write key, which belongs in development. A
   production deployment runs a **read-only** key and should harvest nothing — a write key in
   production registers phrases from live user traffic, and the catalog pollution is permanent
   and shared.

**[OPEN]** Whether registration should be attempted at all under a read-only key, or refused
with a clear log line. Refusing is probably right, but confirm the API's behavior rather than
assuming a 4xx.

---

## 7. Hand-off to the client SDKs

When a client SDK hydrates over this package's output there is **one DOM**, and it now contains
already-translated text plus markers.

Required properties **[PROPOSED]**:

1. The client must **not** re-translate what the server translated, and must not re-register
   content blocks the server already registered.
2. The client's seeded catalog must be the **same catalog** the server rendered against, or
   hydration will disagree. This makes deterministic locale resolution a hard requirement —
   which is a strong argument for **locale in the URL** rather than content negotiation.
3. Seeding must apply **before** hydration, not in `onMount`. Today the client SDKs seed
   inside `init()` in a mount hook, which is after hydration — fine when the server emitted
   base language, a mismatch when it emitted Italian.

**[OPEN]** Point 3 is a genuine change to the client SDKs' handoff, and it is the part of this
design most likely to require coordinated releases. Determine whether the client SDKs can seed
synchronously from a serialized payload at module scope, and what that does to their existing
`initialTranslations` contract.

For reference, the current seeding contract **[VERIFIED]** against `0.6.5`:

- `dist/index.mjs:783` — `if (initialTranslations && initialTranslationsLocale)`, no `else`,
  no warning. Passing one alone is a **silent** no-op; the only log sits inside the success
  branch.
- `:784-791` — `init()` **mutates the object you pass it**, writing `__category__` into every
  category and injecting `__uncategorized__`. That object is the framework's server payload.
- `:598` — the seeded no-refetch window is **60 seconds**, not permanent.

---

## 8. Caching and freshness

Server-side rendering does not make translations realtime. It shortens the fuse. Be explicit
about this in the README rather than letting users infer "SSR ⇒ current".

Observed in the reference deployment **[VERIFIED]**:

| Layer | TTL |
|---|---|
| CDN / HTTP | `no-store` — none |
| In-process catalog memo | 5 minutes |
| Client SDK re-fetch window | 60 seconds |

**The multi-worker problem must be addressed by this package's design, not left to users.**
Two PM2 instances mean two independent in-process caches, so during propagation the same URL
alternates between old and new copy depending on which worker answers. To a non-engineer that
reads as "my change didn't save."

**[OPEN]** What this package should do about it. Options include a shared cache backend
(Redis, as `langsys-php` already supports via `LANGSYS_CACHE_DRIVER`), a cache-busting
signal from the Translation Manager, or documenting it loudly with a recommended TTL. PHP has
faced this exact problem already and its answer should be examined first.

---

## 9. Translatable attributes

Attribute values are translatable, and the list is **not** guessable. Transcribe it from the
published SDK constant rather than from memory — this specific list was previously written
from memory in `langsys-skill`, and the result invented an entry, omitted nine, and missed
`value` entirely, with tests that asserted the list against itself.

Source of truth: `langsys-js-typescript` `TRANSLATABLE_ATTRIBUTES` and PHP's equivalent. At
`0.6.5` **[VERIFIED]**:

```
placeholder, alt, title, label,
aria-label, aria-placeholder, aria-description,
aria-valuetext, aria-roledescription,
data-error, data-error-message, data-validation-message,
data-invalid-message, data-required-message, data-pattern-message
```

Plus `value` on `<button>` and on `<input type="submit|button">`.

**[OPEN]** Confirm PHP's list matches exactly. If it does not, that divergence is a defect in
one of them and needs an owner's decision, not a merge.

---

## 10. How this project verifies things

This is not boilerplate. The Langsys SDK family has a documented, recurring failure class, and
every agent involved in producing this specification has committed an instance of it during
the design discussion.

> **A check that produces no signal reads as a pass.**

Recorded instances include: ast-grep rule files silently rejected so an entire scan aborted
and reported clean; a peer-floor check that read `node_modules` and skipped silently when
absent; a translatable-attribute list written from memory and asserted against itself; a
documentation claim that SSR emits translated HTML, which every `curl`-shaped check agreed
with because `curl` shows base language on a working page *and* on a broken one.

Rules that follow, and that this package should adopt:

1. **Verify against the published artifact**, at a pinned version — never a sibling working
   tree, which can lead the registry by several commits.
2. **A check must come from a different source than the claim**, not merely a different file.
   Tests written from the same memory as the code inherit its errors.
3. **Execute rather than read**, where execution is possible. The three-way split in this
   family's diagnostic gating — one warns by default, one is debug-gated, one does not exist —
   is hostile to inference and yielded only to running it.
4. **Before believing a negative result, prove the code path ran.** A test that exits early
   produces the same output as the phenomenon under test. Assert on positive evidence (a
   returned `HTTP 422`, a "scan succeeded" line), never on absence of output alone.
5. **A fixture set of one proves nothing about a parser.** A checker correct on its only input
   and wrong on its second is indistinguishable from a working one until the second input
   exists.
6. **Inherited premises are the least-verified thing in any report**, including a well-verified
   one. Claims arriving as premises inside someone else's argument never present themselves as
   needing a test. When acting on this document, re-run the claims you are building *on top
   of*, not the ones being argued *for*.
7. **Tests should be majority-negative.** A rule that only proves it fires is half-tested; the
   failure that hurts is flagging correct code, because someone acting on it rewrites working
   code into the bug the rule exists to prevent.

Rule 6 applies to this document with particular force. It was assembled from a design
conversation, and its **[VERIFIED]** tags are only as good as the artifact citations beside
them. Check them.

---

## 11. Naming

**[OPEN]** The working name is `langsys-js-server` rather than `langsys-js-node`.

Argument for `-server`: server rendering also happens on Deno, Bun and Cloudflare Workers, all
of which support `AsyncLocalStorage`. `-node` reads as a runtime restriction that is not
intended, and it is free to change now and expensive later.

Argument for `-node`: if the implementation ends up genuinely requiring `node:async_hooks`
with no viable path on other runtimes, the narrower name is the honest one.

Resolve before first publish. The npm org is `langsys`, packages are **unscoped**, and access
is granted via the `langsys:langsys` team.

---

## 12. Open questions, collected

Do not begin building the affected section until these are resolved.

| # | Question | Section | Owner |
|---|---|---|---|
| 1 | Is ALS-based scoping sufficient, or does other module state leak per request (the `persist()`/`localStorage` wiring is the obvious suspect on a server)? | §3.1 | base SDK |
| 2 | Can Svelte 5 / React / Vue each render a child tree to a string at render time, and at what cost? | §3.3 | framework SDKs + reference deployment |
| 3 | Can the tokenizer produce byte-identical tokens from an HTML string as from a DOM? Prove on fixtures before committing. | §5 | this package + PHP |
| 4 | Should registration be attempted under a read-only key, or refused with a log line? | §6 | base SDK |
| 5 | Can client SDKs seed synchronously before hydration, and what does that do to the `initialTranslations` contract? | §7 | client SDKs |
| 6 | What should this package do about multi-worker cache inconsistency? What does PHP already do? | §8 | PHP |
| 7 | Do the JS and PHP translatable-attribute lists match exactly? | §9 | PHP |
| 8 | `-server` or `-node`? | §11 | Darryl |

---

## 13. Definition of done for v0.1.0

A first release should be able to demonstrate, on a real deployment:

1. A crawler fetching `/it` receives **Italian body copy** in the served HTML — verified by
   byte count on visible text, in the same way the original problem was measured. This is the
   acceptance test. Everything else is supporting work.
2. `<Phrase>` sentences arrive whole, with plurals correct in a language that has more than
   two plural forms.
3. Concurrent requests for different locales never cross-contaminate, under load, on more than
   one worker.
4. Harvesting registers phrases without measurable TTFB impact.
5. A client SDK hydrating over the output produces no hydration mismatch and issues no
   duplicate catalog fetch.
6. The conformance fixture set passes identically here and in `langsys-php`.

**Verify (1) in a browser and by inspecting served bytes — never with `curl | grep` alone.**
Because client-side translation happens after hydration, a `curl` check shows base language on
a correctly working page and on a completely broken one, and cannot distinguish them. That
ambiguity is what let the original defect survive in four documents.

---

## 14. Review log

| Date | Reviewer | What changed |
|---|---|---|
| 2026-08-21 | `langsys-skill` agent | Initial draft from the SSR design discussion |
