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
| A per-request instance is **not** isolated | `:410-411` — `Translations`' own constructor subscribes to those globals |

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

**A caveat added by the PHP owner.** That tiebreak is a sound default and it is not a proof.
This review breaks it twice, in opposite directions: on `&nbsp;` (§5) PHP's behaviour
fragments *its own* catalog on characters no human can see, and on multi-worker caching (§8)
PHP has no answer to examine because its deployment model never posed the question. "Years of
production behind it" is evidence that a behaviour has not produced a **visible** failure.
The failure class in §10 is exactly the class that stays invisible for years.

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

#### What module state actually leaks per request — answered

Open question #1, answered by the base SDK owner against `langsys-js-typescript` `src/` at
`0.6.5`. **The two-accessor claim is true but much narrower than it reads**, and the prime
suspect was the wrong suspect.

**`buildTFn` really does depend on only `sTranslations.get()` and `currentlyLoadedLocale.get()`
(`src/translations.ts:124`, `:144`) [VERIFIED].** That bounds *phrase lookup*. It does not bound
the SDK, because everything around lookup — auth, key type, catalog fetching, harvesting,
locale memos — reads different module state.

**`persist()` is clean. [VERIFIED]** `getSafeStorage()` returns `null` when
`typeof window === 'undefined'`, and `persist()` calls it **once at module init**
(`src/persist.ts:9`, `:35-37`), so on a server `sTranslations` degrades to a plain in-memory
Signal and never touches `localStorage`. No writeback subscriber is even attached. The
suspicion was reasonable and it does not hold.

What does leak, all **[VERIFIED]** and all invisible with one user:

| # | State | Where | Why it matters on a server |
|---|---|---|---|
| 1 | `config` — a module-level **mutable** object | `src/stores.ts:17-24` | Holds `projectid`, `key`, `key_type`, `baseLocale`, `debug`, `sUserLocale`. `init()` writes into it (`langsys-app.ts:115`), and `LangsysAppClass`'s constructor **aliases it by reference** (`:34`). This is **cross-tenant**, not merely cross-locale. |
| 2 | `LangsysAppAPI` singleton: `this.config`, `this.headers['x-Authorization']`, `apiurl` | `src/api.ts:157`, `:31-35`, `:39` | `setup()` overwrites the auth header, and `validate()` calls `setup()`. Two concurrent requests for different projects race on **which API key goes out on the wire**. Strictly worse than a stale catalog: a wrong-tenant read, not a wrong-language render. |
| 3 | `Translations` instance fields: `missingTokens[]`, `lastLoaded{}`, `locale`, `flushScheduled`, `isFirstClientRun` | `src/translations.ts:36-42` | They sit on the singleton, so they are module-global in effect. Under the **default** `ssrTokenStrategy: 'client'` the SSR branch only logs (`:209-212`) — server-side misses are queued and **never drained**, growing for the life of the process, deduped by an O(n) linear scan per miss (`:174`). |
| 4 | `LangsysAppClass` locale memos: `locales`, `countries`/`countriesLocale`, `dialCodes`/`dialCodesLocale`, `currencies`/`currenciesLocale` | `src/langsys-app.ts:20-29` | **Single-slot caches keyed by "the last locale asked for."** Concurrent `/it` and `/de` renders thrash one entry and can serve each other's country and currency lists. |
| 5 | `logger` singleton `debugEnabled` | `src/logger.ts:47` | Process-wide, not per request. Minor, but it is state. |

One thing is genuinely clean besides `persist()`: the 3s flush `setInterval` is guarded to the
client (`src/translations.ts:236`, `:246-247`), so no timer is created on a server. **[VERIFIED]**

#### The consequence for this package: importing the base SDK is not free

`src/langsys-app.ts:391` runs `new LangsysAppClass()` **at module scope**; its constructor
builds a `Translations`, whose constructor subscribes to both globals; and `src/index.ts:86`
reads `_LangsysApp.Translations.tSignal` at module scope too. `package.json` declares a
**single `"."` export and no `"sideEffects"` field** — so there is no subpath to import from
and no reliable way for a bundler to drop it. **[VERIFIED]**

> `import { generateCustomId } from 'langsys-js-typescript'` instantiates the entire
> singleton graph — shared catalog, shared miss queue, shared auth header — inside the
> server process.

The functions this package wants (`generateCustomId`, `generateLegacyCustomId`,
`tokenizeElement`, `interpolate`, `canonicalizeLocale`, `md5`) are genuinely pure, so the
*logic* is safe to reuse. The **module graph** is not.

**[OPEN]** How to consume them: vendor the pure functions with a conformance test pinning them
to the published SDK, or ask the base SDK for `sideEffects: false` plus a
`langsys-js-typescript/pure` subpath export. The second is better for parity and is a small,
non-breaking change — but it is the base SDK owner's call and is **not yet agreed**. Do not
assume it will exist.

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
  (`dist/index.mjs:473`).
- `|| phrase` does not guard the object case; the SDK checks
  `typeof value === 'string' && value.length > 0` (`:466`).

  > Both line numbers were wrong in the first draft (`:144` and `:136`), and the error came
  > from the base SDK agent, who quoted `src/translations.ts` line numbers that were then
  > recorded against `dist/index.mjs`. The claims were correct; the citations pointed at
  > `patch()` and `post()`. Re-checked by reading the dist. This is §10 rule 6 in miniature:
  > the numbers arrived as premises inside an argument about something else.

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

### PHP's actual marker behaviour — measured, and the table above overstates it

**[VERIFIED]** by executing `langsys-php`'s `HtmlParser` at `a76ed1a`, not by reading it.
Three corrections, in increasing order of consequence.

**1. `data-ls-phrase` is not recognised by `langsys-php` anywhere.** The string does not occur
in `src/` or `tests/`. Recognition is **one-way**: the JS tokenizer knows both spellings, PHP
knows only `data-langsys-phrase`.

**2. PHP's `isPhraseMarked()` is not called by PHP's tokenizer.** It has exactly one caller,
`src/Html/PageTranslator.php:336`. `HtmlParser::extractPhrases()` — the content-block path,
and the one that feeds `generateCustomId` — deliberately ignores it. The reason is a comment
at `src/Html/HtmlParser.php:322-331`: content blocks are applied by a path with no tokenized
branch, so honouring the marker there "registered a tokenized catalog entry that could never
be rendered". The predicates are mirrored byte-for-byte; the **call sites are not**, and only
the call sites affect identity.

Measured — all three yield the identical 3-token split:

| input | tokens |
|---|---|
| `<span data-langsys-phrase>Based on <b>5</b> reviews</span>` | `["Based on","5","reviews"]` |
| `<span data-ls-phrase>…</span>` | `["Based on","5","reviews"]` |
| `<span>…</span>` — **control** | `["Based on","5","reviews"]` |

The control is not decoration. Without it, "the marker had no effect" and "the probe never
ran" are the same output — §10 rule 4.

**3. This is live in the reference deployment's own topology.** §1 records it as
`adapter-node` **behind a PHP proxy**. A page this package renders with `data-ls-phrase`,
passing through a PHP layer that calls `translatePage()`, has its kept-whole sentences
re-split — the precise failure §3.2 exists to prevent, arriving from the one direction nobody
is watching.

**The JS side of this costs nothing — confirmed by the base SDK owner. [VERIFIED]**
`isPhraseMarked()` tests **both** spellings (`src/content-block.ts:121-127` over
`PHRASE_MARKER_ATTRS = ['data-ls-phrase', 'data-langsys-phrase']`, `:81`), with identical
`="false"`/`="0"` opt-out semantics on either. Only *writing* is single-spelling —
`PHRASE_MARKER_ATTR = 'data-ls-phrase'` (`src/phrase.ts:9`). So a subtree marked
`data-langsys-phrase`, or marked with both, is skipped by the JS walker exactly as one marked
`data-ls-phrase` is.

One thing worth stating so nobody has to wonder: **the marker attribute does not enter
`tokens[]` and cannot change a `custom_id`.** Attribute harvesting reads only
`TRANSLATABLE_ATTRIBUTES` by name (#11 above), and a marked element is skipped before
harvesting anyway. Emitting both spellings changes only the `content` snapshot string, which is
the translator-facing HTML, not the identity. **Emitting both is free on the JS side.**

**Recommendation.** This package emits **`data-langsys-phrase`** — the spelling both other
implementations understand — and may emit `data-ls-phrase` alongside it. Emitting only the JS
spelling is the single combination that is silently wrong in a topology that ships today.
Teaching PHP `data-ls-phrase` is a small additive change and worth doing, but it does not
remove the need for this package to emit the spelling that works now.

What the table gets right, also measured: `translate="no"` and a **bare** `data-notrans` both
drop the subtree **and its attributes** — `<div><img translate="no" alt="X"><span>keep</span></div>`
yields `["keep"]` against a control of `["X","keep"]` — and `data-notrans="false"` opts back
in, yielding `["X","keep"]`. PHP matches the JS behaviour described in §5.

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

### Canonicalization: the self-rendered string is not the inline string

**[VERIFIED]** by the Vue owner against Vue 3.5.39, running `renderToString`, not reasoning
about it. Rendering a slot to a string mid-SSR works — and the resulting string differs from what
the same subtree emits inline, in two ways:

```
self-rendered: <!--[-->Based on %n% <strong>reviews</strong> &amp; &lt;ok&gt; &quot;quoted&quot;<!--]-->
inline:                Based on %n% <strong>reviews</strong> &amp; &lt;ok&gt; &quot;quoted&quot;
```

1. **Fragment anchors `<!--[-->` / `<!--]-->` are unconditional** — even for a single text child,
   because the slot call returns an array and the throwaway app's root is therefore a fragment.
   Deterministic, so strippable, but you have to know.
2. **Entities are escaped.** `&` → `&amp;`, `<` → `&lt;`, `"` → `&quot;`.

**Divergence 2 is a `custom_id` hazard and it has a normative answer.** The client walker reads
`textContent`, which is **decoded**. PHP's `DOMDocument` also yields decoded text from
`nodeValue`. So **two of the three implementations already agree on decoded text**, and a
string-based tokenizer that skips decoding is the odd one out.

> **The canonical form is decoded text.** A string-based tokenizer MUST decode entities before
> tokenizing, or `Tom & Jerry` produces `Tom &amp; Jerry` on the server and `Tom & Jerry` on the
> client — two catalog entries, silently, for a phrase whose only sin is an ampersand.

This will not surface on ASCII-clean fixtures. **Put `&`, `<`, `>`, `"`, `'` and `&nbsp;` in the
conformance set explicitly**, since the failure is invisible without them and every casual test
corpus omits them.

Both normalizations — anchor stripping and entity decoding — belong in the **shared string→string
core as an explicit canonicalization step, not in each adapter.** Three adapters normalizing
independently is three chances to disagree, and the disagreement is silent.

### Svelte: synchronous, but capture re-executes exponentially

**[VERIFIED]** by the Svelte owner against **5.55.8**, compiled with `generate: 'server'` and run
in Node. No inference in any of it.

**Yes, and synchronous.** `render()` from `svelte/server` is re-entrant; a snippet needs wrapping
in a throwaway component because `render()` takes a component. Two caveats:

- **The wrapper depends on the snippet's internal calling convention** — in 5.55.8 a snippet takes
  the renderer object; in earlier 5.x it was `$$payload`. **Not public API, and it has already
  changed once within Svelte 5.** Any adapter built on this must pin and test against the Svelte
  version rather than assume forward compatibility.
- **`render()` is lazy.** It returns immediately and `.body` is evaluated on access, so "did it
  run yet" and "did I call render yet" are different questions. Their first harness measured this
  wrong and reported a callback as never firing.

**The finding to design around: nested capture re-executes the subtree 2^depth times.** Measured
with one side-effecting leaf at capture-depth 3:

```
capture invocations, in order : L3 L2 L3 L1 L3 L2 L3
side-effecting leaf executed  : 8 times, for ONE leaf
```

**For `<Translate>` this is a correctness problem, not a performance note**, because the captured
subtree contains `t()` calls and **`t()` registers missing tokens as a side effect**. Three nested
blocks would fire eight registration passes over the innermost content.

> **Requirement:** capture must be memoised per snippet identity, **or** token registration must be
> suppressed during capture passes and run only on the emitting pass. This interacts directly with
> §6 — a request-scoped miss queue that dedupes before sending absorbs the damage, but dedup is a
> mitigation and suppression is the fix.

**[OPEN]** Whether Vue's nested-`createApp` strategy has the same multiplication. The mechanisms
differ enough that it does not follow, and it was not measured.

### The cross-framework synthesis: strip comments, decode entities

Two independent measurements, two frameworks, same shape:

| | Emits | Must be stripped before hashing |
|---|---|---|
| Vue 3.5.39 | `<!--[-->` / `<!--]-->` fragment anchors, unconditional | yes |
| Svelte 5.55.8 | `<!--[-->`, `<!---->`, `<!--]-->` boundary markers | yes |

Svelte's three-way comparison shows the instability is not even introduced by capture — it is
already there:

```
captured : <!--[--><!---->Hello <strong>bold</strong> … tail<!--]-->
inline   :          <!---->Hello <strong>bold</strong> … tail<!---->
literal  :                 Hello <strong>bold</strong> … tail
```

Passing a subtree as `children` adds anchors that writing the same markup inline does not. **"The
same subtree" is not byte-stable in Svelte before string capture enters the picture at all.**

**The reassuring half, and it was tested specifically because it is the difference between
cosmetic and catastrophic: anchors mark component, snippet and block boundaries — not
interpolations.** A text run containing expressions stays one run:

```
<Capture>Hello {name} world, you have {3} items</Capture>
  -> text runs: ["Hello Sarah world, you have 3 items"]      one, not five
```

So **token text is stable across capture and inline; only the markup framing moves.** That is what
makes the design viable.

### React: don't capture a string at all — walk the element tree

**[VERIFIED]** by the React owner against React 19.2.7. Nested rendering works cleanly — no
re-entrancy complaint, and `useId` is **not** perturbed (the nested pass gets its own counter, and
the outer sequence is byte-identical to a baseline without one). But two walls and one loss make
string capture the wrong strategy for React specifically.

**Context is lost**, exactly as in Vue: the nested render is a fresh root with no provider chain,
so a child reading context renders differently captured than inline — silently. This is now
**confirmed in two frameworks independently** and should be treated as a property of nested-render
strategies generally, not a per-framework quirk.

**RSC — two walls, and the second is worse than the first.**

- **Server Component `<Translate>`: hard-impossible.** Under the `react-server` export condition
  `react-dom/server` is not importable at all — every server entry routes to a stub that throws.
  Verified by execution with `node --conditions=react-server`. Not suppressible; the module
  resolves to a thrower.
- **Client Component with server children: silent.** *(reasoned by the React owner, not run.)*
  In the SSR pass `react-dom/server` is available so nothing throws, but children crossing a
  Server→Client boundary arrive as lazy Flight references — structurally identical to the async
  case they *did* measure, where the capture returned the Suspense **fallback** string with no
  error and no warning. **Wall 1 fails at import; Wall 2 mis-keys the catalog and says nothing.**

**The recommendation, and it is a different adapter shape from Svelte and Vue:** do not render to
a string. **Walk the `children` element tree as data.** A React element tree is plain data —
`string | number` is a text token, an element tokenizes `props` by attribute name and recurses into
`props.children`. That reproduces the DOM walker structurally and dodges every problem at once:

- no string round-trip, so the separator/coalescing question never arises — one token per text
  child by construction
- **synchronous and RSC-agnostic**: no `react-dom/server` import, so Wall 1 disappears entirely and
  a Server Component `<Translate>` becomes possible
- no context loss, because nothing is re-rendered
- a lazy or function-component child is **detectable** (`$$typeof === Symbol.for('react.lazy')`),
  so the adapter can **fail loudly instead of silently mis-keying** — the single most valuable
  property here, given both walls above

Limitation: a function component in `children` cannot be walked without rendering it. **Make that
a hard error rather than a fallback.** `<Translate>` children are markup by contract, and silent
mis-keying is the worse outcome.

**This is the strongest validation of the adapter architecture so far.** Three frameworks, three
genuinely different capture mechanisms — Svelte a synchronous re-entrant `render()`, Vue an async
throwaway app, React a data walk with no renderer at all. A single shared mechanism would have had
to be the worst of the three.

### CLOSED — the non-coalescing contract is stated and pinned

> **The contract is in source, not in a published artifact.** `a654f47` is on `main`; the
> published `langsys-js-typescript` is still **0.6.5**, which predates it. So the version this
> package pins has the correct *behaviour* and none of the *guard* — the tests that would catch a
> regression ship in the next release. Pinning `0.6.5` remains right; just do not read the pin as
> protection. It is a bet on a behaviour, and the thing that makes it a contract arrives later.

`langsys-js-typescript@a654f47`, verified: an **IDENTITY CONTRACT** comment on `_walkForTokens`
(`src/content-block.ts:314` — "one token per text node. Do not coalesce."), a
`tests/content-block-identity.test.ts` with seven token-array assertions and pinned id literals,
and a `CLAUDE.md` line so the next agent meets the contract before touching the walker.

**They mutation-checked it rather than shipping it green** — added `clone.normalize()`, the exact
forbidden cleanup, confirmed three tests went red, reverted, and recorded it in the commit body.
Their framing belongs next to §5's conformance requirement:

> **A protective test that has never been observed failing is only assumed to protect.**

In a family whose failures all render as passes, that is not pedantry — it is the difference
between a guard and a decoration.

One incidental result from the mutation matters for fixture design: **the comment-skipping test
still passed under `normalize()`**, because `normalize()` does not merge across a comment. So
coalescing and comment-skipping are **independently pinned** rather than one test standing in for
both — and that was knowable only by running the mutation, not by reading the tests.

### §5 seed fixtures — five verified cases

Contributed by the React owner, run against the shipped dist; the first three on jsdom, and the
coalescing pair independently reproduced by the base SDK on happy-dom.

```
1. text-node arity      <span>Hello {name}!</span>
                        3 adjacent text nodes -> ["Hello","Bob","!"]
                        1 merged text node    -> ["Hello Bob!"]      DIFFERENT id

2. comment separation   text <!-- --> text    -> 2 tokens, comment skipped
                        (must NOT merge the runs)

3. hydration parity     client-only render === hydrated SSR DOM       SAME id
                        renderToStaticMarkup                          DIFFERENT id
                        renderToString                                SAME id

4. attribute order      <img src title alt>   -> ["A","T"]
                        <img src alt title>   -> ["A","T"]            SAME id
                        (constant order, never element enumeration order)

5. exclusion scope      <p>Keep <img alt="ALTTEXT"> end</p>
                          -> ["Keep","ALTTEXT","end"]
                        …translate="no" on the <img>      -> ["Keep","end"]
                        …translate="no" on an ancestor    -> ["Keep","end"]
                        CONTROL: <img alt="ALTTEXT"> alone -> ["ALTTEXT"]
```

**Two structural notes for whoever builds the fixture file:**

- **Cases 4 and 5 are cross-SDK, not React-specific** — the base SDK confirmed `langsys-php`
  shares the attribute-order property. They are the *better* fixtures precisely because they
  depend on no framework's renderer.
- **Only case 3 needs the browser-side arm.** 1, 2, 4 and 5 run headless off an HTML string, so
  **split the fixture file that way** and PHP and this package can consume the majority with no
  DOM harness at all.

### `content` is never a conformance-fixture field

**Requested by the base SDK owner, and worth closing the door on before someone opens it.**

`tokenizeElement` returns `tokens` **and** `content`. Only `tokens` is identity. `content` diverges
between implementations for at least three reasons, **all of them correct**:

- computed styles are inlined from a **live mounted** element, so a pre-mount or server derivation
  legitimately lacks them
- `img.src` absolutizes against a DOM base URL, which a server parse does not have
- HTML parsers normalise quoting, self-closing forms and entities differently

None of these touch `tokens[]` or `custom_id`.

> **Never assert `content` equality in a shared fixture.** It will fail for reasons that are all
> correct, and the natural fix — making the snapshots match — would be pure damage: it would force
> one implementation to reproduce another's incidental serialisation for no gain in identity.

`content` is translator-facing HTML. Divergence there is cosmetic and should be documented, not
enforced.

### The one deliberate three-way divergence: `<script>` / `<style>`

Recorded so §9's divergence picture stays complete, because this one is **chosen**, not inherited.

The PHP owner measured that their content-block path queues analytics JS and CSS for **permanent
catalog registration** — `window.dataLayer.push(...)` and `.plan{color:#fff}` arriving as
translatable phrases — and that `tokenizer-reference.json` case `[12]` currently asserts that
output *as the contract*. The base SDK's walker has the identical hole.

`langsys-js-server` skips `script` / `style` / `noscript` / `template`, at both siblings' request:
**do not implement bug-compatibility.**

This is the same shape as the attribute-list trade the builder argued *against* taking — disagreeing
with your hydration partner on a per-request basis. It was taken anyway, and the reasoning is worth
preserving:

- **Registering executable code into a permanent, shared catalog is a product harm**, not a keying
  difference. The two are not comparable costs.
- **It was mitigated rather than accepted.** The *read* path falls back to the un-skipped
  derivation, so a block registered by either sibling still resolves. Only *registration* uses the
  corrected derivation.

That asymmetry — corrected on write, tolerant on read — is the general pattern for diverging from a
sibling safely, and it should be reused wherever else this package has to. **[OPEN]** for the
siblings: whether the walkers are fixed and case `[12]` re-baselined, which is a catalog migration
of the same kind as §9's.

### §5 has TWO pipelines, not one — and the contract governs only one of them

**This reshapes the fixture set rather than extending it.** Found by the React owner, verified
independently by the Svelte owner, and confirmed here against published `0.6.5`.

The base SDK has **two identity mechanisms with opposite text handling**, both shipped:

| Path | Mechanism | Adjacent text | Artifact |
|---|---|---|---|
| `<Translate>` | `_walkForTokens` | **NOT coalesced** — arity is identity | `tokens[]` → `custom_id` |
| `<Phrase>` | `encodeRichText` | **coalesced**, whitespace collapsed | an encoded **phrase string** |

Verified in `dist/index.mjs`: `:1599` accumulates adjacent text (`out += node.nodeValue ?? ""`),
`:1593` collapses and trims (`phrase.replace(/\s+/g, " ").trim()`), `:1606` wraps markup as
`{m0o}`/`{m0c}`. `<Phrase>` produces **no content block at all** — no `tokenizeElement`, no
`generateCustomId`, no `custom_id`. It does a plain `Translations.t(phrase, category)` lookup.

> **So "never coalesce adjacent text nodes" is correct for the `<Translate>` path and actively
> wrong for the `<Phrase>` path.** On the rich-text path, coalescing is not the hazard — it is the
> intended behaviour.

**Why this is a framing problem and not a missing fixture.** A fixture set that encodes "never
coalesce" is correct in every case it contains and teaches a wrong general rule. The Svelte owner's
statement of the risk is the one to keep:

> The danger is not a server implementation getting `<Phrase>` wrong on its own terms. It is an
> implementer who has **internalised the contract**, meets `encodeRichText`, recognises it as the
> exact defect they were warned about — and corrects it.

That is the absence pattern one level up, and the React owner's framing of the escalation is exact:

> **A fixture without its control can *pass* for the wrong reason. A fixture set without its scope
> can be *obeyed* for the wrong reason.** The first exports a weak test; the second exports a wrong
> belief — and the second is harder to catch, because every individual fixture still passes.

**Three consequences for §5's structure:**

1. **Tag every fixture by path** — `content-block` vs `rich-text-phrase`. Not one flat identity
   suite. A consumer must be able to tell which rule it is implementing.
2. **The rich-text path needs its own inverse fixture** — one that fails if someone *removes*
   coalescing from `encodeRichText`. Everything pinned so far protects against coalescing being
   **added**; nothing protects the path where it is **required**. That asymmetry is precisely how
   the misapplication ships green.
3. **`<Phrase>` fixtures assert on the encoded phrase string** — `"Based on {n} {m0o}reviews{m0c}"`
   — not on a token array or an id. **A fixture runner assuming `(html → tokens[] → custom_id)`
   uniformly cannot express them at all.** This is load-bearing for the file format: the shape §5
   has been converging on assumes one pipeline, and there are two.

**Evidence the distinction is not obvious from the code:** `langsys-js-svelte@3.6.5` shipped the
right advice with the wrong mechanism named, corrected in `3.6.6`. Two agents made and caught the
same error independently within a day. Anyone implementing against this specification should expect
to make it too.

### CLOSED — the contract now names its own boundary

`langsys-js-typescript@eb3dc66`, verified: a **SCOPE** section on the `_walkForTokens` contract
(`src/content-block.ts:348`) naming both mechanisms side by side and stating that coalescing is the
bug in one and the requirement in the other; a counter-warning at the `encodeRichText` site
(`src/richtext.ts:81`) explaining *why* the coalescing is correct — a sentence must survive whole or
plural agreement is impossible in languages with more than two forms — and noting that arriving
there from the other comment intending to make the two consistent **is** the mistake; plus three
tests pinning the Phrase direction, closing the one-directional guard.

Both ends are named, and the warning sits **where the well-intentioned edit would actually land**
rather than only where the rule is stated.

**The base SDK's diagnosis of what their comment previously said is the cleanest instance of this
failure class in the whole project.** It said:

> *"do not scope this contract to a framework"* — and — *"the invariant is about the token array,
> not about any renderer."*

**Both true. Both push a reader toward "never coalesce adjacent text nodes, anywhere."** The
misapplication, delivered as the lesson, by two statements that are individually correct.

That is a distinct variant worth naming: not a wrong claim, and not a silent absence, but **two
correct statements composing into a wrong generalisation.** Nothing in either sentence is
falsifiable; the defect lives in what they jointly imply. A proofreader finds nothing, because
there is no wrong sentence to find.

### Mutation standard for the inverse fixtures

> **The mutation should be the mistake you are actually afraid of.**

The base SDK mutation-checked the new Phrase tests by **modelling the actual misapplication** —
changing `richtext.ts` to `.trim()` each text node independently, which is literally what applying
the walker's rule there would look like — rather than any edit that produces red.

For a corpus whose entire purpose is **to be generalised from**, that is the right standard for the
inverse fixtures specifically: an arbitrary break proves only that a test *can* fail, not that it
catches the thing it exists for. Pair every inverse fixture with a named mutation describing the
plausible wrong edit it is meant to intercept.

### Fixture design rule: every absence needs a paired presence

Case 5's control is the point, and it must not be dropped when this becomes a file.

An assertion that an excluded `alt` produces **no token** passes trivially if `alt` was never
harvested in the first place. The absence is equally consistent with "exclusion works" and "the
feature does not exist." The control — `<img alt="ALTTEXT">` alone yielding `["ALTTEXT"]` —
proves harvesting is *possible*, which is what makes the absence mean anything. It also fails
loudly if `alt` ever leaves `TRANSLATABLE_ATTRIBUTES`, which would otherwise hollow out the
exclusion case while leaving it green.

> **Every fixture asserting an absence needs a paired fixture establishing presence.**

Half the interesting properties in this domain are exclusions — `translate="no"`, `data-notrans`,
phrase markers, excluded subtrees — and **every one of them is vulnerable to passing for the
wrong reason.** This is the same failure class as §10's absence pattern, arriving in test design
rather than in a check.

**On the pinned literals:** the base SDK's id literals derive from current source rather than a
published tarball. They agree today. **The shared fixture set is the durable fix** — one artifact
everyone derives from, rather than four repos independently pinning from their own local builds.
That is the strongest argument for §5 existing at all, and it came out of them declining to
overclaim what they had shipped.

### The client DOM — MEASURED for React, still open for Svelte

**[VERIFIED]** by the React owner in jsdom 29 + React 19.2.7, running `tokenizeElement` and
`generateCustomId` **lifted unmodified from the installed `dist/index.js`** — the shipped
tokenizer over real DOM states, not a reimplementation of it.

For `<span>Hello {name}!<br/><b>bold</b></span>`:

```
A. client-only render (createRoot)
   nodes : text("Hello ") text("Bob") text("!") <br> <b>
   tokens: ["Hello","Bob","!","bold"]        id 3e3e0a10…

B. SSR renderToString -> HYDRATED live DOM
   nodes : text("Hello ") comment(" ") text("Bob") comment(" ") text("!") <br> <b>
   tokens: ["Hello","Bob","!","bold"]        id 3e3e0a10…

C. renderToStaticMarkup -> parsed
   nodes : text("Hello Bob!") <br> <b>
   tokens: ["Hello Bob!","bold"]             id 9d499689…   DIFFERENT

D. renderToString -> parsed
   identical to B                            id 3e3e0a10…

A === B  true      B === C  FALSE      B === D  true
```

Three results, one of which was not predictable:

1. **Client-only and hydrated agree.** The separators do not perturb identity. Not guaranteed in
   advance.
2. **The `<!-- -->` comments survive hydration and live in the client DOM.** They are not a
   transport artifact React cleans up. So the isomorphism is not merely "in the SSR string" — it
   is in the DOM the walker actually traverses.
3. **`renderToString` round-trips the React client DOM exactly**, and the "parse, do not regex"
   correction is doing precisely the necessary work: a regex that strips comments merges the text
   runs and lands on **C**, the wrong id.

**Still [OPEN] for Svelte, and the prediction is not reassuring.** Svelte's captured text runs stay
whole — `Hello {name} world` is **one** token server-side — but Svelte compiles interpolations to
separate text nodes updated via `set_data`, which would make it **three on the client and one on
the server**. That is React's problem in mirror image and **worse**, because Svelte emits no
separator comments, so nothing records the boundary. **Prediction, not measurement** — flagged as
such, and cheap to settle.

The harness generalizes in about twenty lines; only the render call is framework-specific. Run the
framework's client render into jsdom, run the **real** `tokenizeElement` from the installed `dist`
(append one export line to a *copy* of `dist/index.js` — the functions are module-internal but
top-level in the bundle, so exposing them needs no logic change), and compare `custom_id` against
the server path. The React owner has sent the recipe to the Svelte owner to settle in their repo.

**Adopt this harness as the conformance suite's browser-side arm.** It is the only check that
compares the two halves of `custom_id` identity, and §13's acceptance criteria should require it
per adapter.

### CORRECTION — do NOT strip comments. Parse them.

**This section previously instructed the core to strip HTML comments before tokenizing. That is
wrong, and following it would fragment every React catalog at interpolation boundaries.** The
React owner disproved it by reading the installed tokenizer rather than reasoning about it.

Two facts I did not have when I generalized from Vue and Svelte:

1. **The walker already skips comments for free.** A comment node is neither `TEXT_NODE` nor
   `ELEMENT_NODE`, so `_walkForTokens` never reaches it. Nothing needs stripping.
2. **Adjacent text nodes are NOT coalesced** — each text node is pushed as its own array entry.
   And React emits `<!-- -->` **precisely where it has adjacent text children**, omitting them
   where it does not. Those comments are therefore an exact isomorphism of the client's text-node
   structure. **They are the boundary record.**

Measured, for `<span>Hello {name}!<br/><b>bold</b></span>`:

| path | text nodes | tokens |
|---|---|---|
| client | `"Hello "`, `"Bob"`, `"!"` | `["Hello","Bob","!","bold"]` |
| `renderToStaticMarkup` | `"Hello Bob!"` | `["Hello Bob!","bold"]` ✗ |
| `renderToString` | `"Hello "`, `"Bob"`, `"!"` | `["Hello","Bob","!","bold"]` ✓ |

So **`renderToStaticMarkup` is the wrong capture primitive** — stripping those separators is its
stated purpose, and the separators are identity. Stripping comments in the core would have done
the same damage to `renderToString` output.

> **The rule is: parse, do not regex.** Parse the captured string into a DOM-shaped tree and run
> the *same* node-type walk the client runs. Comments are then skipped as nodes while still
> separating the text nodes either side of them — which is exactly the behaviour needed, and it is
> also precisely what PHP's `DOMDocument` does. **Never run a separate string tokenizer; two
> tokenizers is how the catalog fragments.**

Entity decoding stands, for the same reason it always did — parsing yields decoded text, matching
`textContent` and `nodeValue`. Parsing gets it for free.

**Recorded as a methodology failure, not just a bug** — and the React owner's diagnosis of it is
sharper than my own, so it is theirs that is recorded:

> Vue's `<!--[-->` and Svelte's boundary markers *are* framework noise; that read was correct.
> React's separators look identical and are the opposite: load-bearing structure. The tell was not
> that there were two observations instead of three. **"Comment" is a *syntactic* category, and the
> property that mattered — does this node carry structure — is *semantic*.** A third framework
> agreeing would not have helped. Reading one renderer's reason for emitting them would have.

That is a materially different lesson from the one I first wrote, and a better one. Mine —
"two agreeing observations are not a general rule" — implies more samples would have caught it.
They would not have. **No number of instances repairs a category error; only the reason does.**

The familiar half remains: stripped comments produce clean, plausible HTML and a stable-looking
id. The defect is invisible from inside the function and only exists relative to a catalog you
cannot see from there.

**[OPEN] — the half nobody has measured.** All of this compares *server string against server
string*. **Nobody has checked what the client walker sees in the live DOM post-hydration**, which
is the other half of `custom_id` identity. Comment nodes are a separate DOM node type and a
text-node walker should skip them, so it is *expected* to line up — but that is inference, and it
is precisely the kind this project has been repeatedly wrong about. **A browser test is required
before anyone relies on it.**

### `<Translate>` slots must not depend on a component-level provide chain

**[VERIFIED]** by the Vue owner, and the most important constraint to come out of open question
#2 — because it is the one that reaches past the adapter into the consuming app.

A nested render is a fresh app context with no parent chain. Measured:

| | `app.provide()` | component `provide()` |
|---|---|---|
| plain nested app | missing | missing |
| grafting the parent's `_context` | **works** | missing |

Grafting `appContext` recovers app-level provides. **Nothing recovers component-level ones** —
they live on the instance chain, and a nested root has no parent by construction.

So any component inside a `<Translate>` slot that injects from an ancestor *component* — a layout
providing theme, a form context, anything using `provide()` rather than `app.provide()` — silently
receives its fallback default, or throws if it has none.

**The failure is invisible in the same way the original SSR defect was: it renders, it just
renders wrong.** No exception on the happy path, no failed request.

The constraint is documentable and worth stating as a rule: **scope `<Translate>` to leaf
content.** That is what you want for tokenization anyway, so the two constraints point the same
direction — mildly reassuring about the design rather than a compromise forced on it.

**[OPEN]** This is *not* Vue-specific in shape. Any framework using a nested-render strategy has
some version of it. React context and Svelte context must be asked about **specifically**, and
the question to ask is about **context propagation, not async** — the async-ness turned out to be
the least consequential of Vue's findings.

### Vue is the async one, and the sync path exists but is walled off

**[VERIFIED]**: `renderToString` is declared `async`, so it returns a Promise regardless;
`renderToSimpleStream` opens with `Promise.resolve(...).then(...)`, deferring even the sync path
to a microtask. Confirmed empirically as not settled immediately after the call.

Vue 3.5 *does* carry synchronous unroll machinery internally — buffers have a `hasAsync` flag and
`unrollBufferSync` handles the all-strings case. **Nothing sync is exported.** Worth recording
precisely, because it changes any future upstream request from "build a sync path" to "export the
one you have."

The string→string core absorbs this: the adapter awaits, the core does not care.

**[OPEN]** `async setup()` requires `<Suspense>` on the **client**. SSR handles it natively — that
is what was measured — but hydration was not tested. If `<Translate>` carries `async setup()`
unconditionally, every consuming Vue app inherits a Suspense requirement, which would be a real
API imposition. The presumed fix is a server-only branch so the client component never becomes
async. **Not built, not asserted.** The Vue owner has offered to test it.

### Pinning the attribute list is necessary and not sufficient

Established by the PHP owner, **by mutation rather than by watching tests go green**, and
implemented in `langsys-php@6e0c540`. This package should carry the same pair.

A suite that runs fixtures against an explicitly configured 27 proves the three tokenizers agree
*given a list*. It proves nothing about whether that list is the one real callers get — nobody
constructs a parser with 27 arguments in production. Edit the default constant and such a suite
stays green while every default-configured app silently re-keys.

So it takes **two assertions, which must live in different places**:

1. **Shared fixtures against an explicitly pinned list** → cross-SDK parity of the tokenizer
   given a list. Shareable; this is the conformance suite.
2. **A local, per-SDK assertion that that implementation's default equals the pinned list**,
   array-identical *including order*. **Not** shareable — it is a claim about one
   implementation's default, not about the contract.

Write the literal out in (2). Slicing it from the constant compares the constant to itself and
passes for any value of it.

**And a pin is still not enough on its own.** The mutation results:

```
reorder alt/title                            -> pin test FAILS
interleave data-tooltip into the ARIA block  -> pin test FAILS
walker reads only first 3 entries,
  list untouched                             -> harvest test fails,
                                                PIN TEST STILL PASSES
```

That third row is the point: **a pin is a list comparison, and it passes just as happily when
the walker has stopped consulting the list.** So the pair needs a third assertion — that every
pinned attribute actually produces a token — with a negative control that an *unlisted*
attribute does not, or it would also pass for a parser that harvests everything.

**Proposed structure, not yet actioned:** put the 27 in the shared fixture file as data, and
have each SDK assert its own default against it. Then exactly one copy of the list exists and
three implementations check themselves against it. **[OPEN]** — this restructures
`tokenizer-reference.json`, which the base SDK asserts against, so it is more than adding a case.

### Adding is free; reordering re-keys everything

Measured by the PHP owner:

```
default                     ["A","T","Body"]  c29b88d2aebbeebabd4edee2c883c910
+ 2 attributes not used      ["A","T","Body"]  c29b88d2aebbeebabd4edee2c883c910
alt/title swapped            ["T","A","Body"]  85bec9a41062151fa0bf135a99e09667
```

Which is why §9's decision is survivable: the 12 append. Any future edit that *reorders* is a
different class of change entirely.

> **State the failure mode plainly, because it is the reason this is worth so much care: a
> re-keyed block does not error. It renders in the base language and re-registers.** That is
> indistinguishable from a phrase that was simply never translated — no exception, no warning,
> no failed request. The catalog quietly grows a duplicate and the page quietly loses its
> translation.

### Sequencing: the first fixture is blocked, and that is not a delay

Raised by the PHP owner and it changes the plan. `tests/fixtures/tokenizer-reference.json` in
`langsys-php` is asserted against directly by `langsys-js-typescript`, so adding the `&nbsp;`
case today lands a red suite in their repo the moment they pull.

More importantly: **a fixture here does not record a fact, it encodes a decision.** JS and PHP
both behave as their authors intended; there is no bug to pin. So the decision on open
question #10 must *precede* the first fixture rather than be discovered by writing one.

That inverts the usual order and is worth stating plainly, because "add a conformance suite"
sounds like work that can start immediately. The suite can start — on the cases where the
three implementations already agree, which is most of them. The divergent cases are blocked on
#10, #11 and #12, and writing them early would either freeze an accidental winner or break a
green build in someone else's repository.

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

#### Open question #11, answered — the JS walker iterates the CONSTANT

**No divergence, and no defect. [VERIFIED]** by reading `_tokenizeAttributes`
(`src/content-block.ts:349-392`) at `0.6.5`:

```ts
for (const attr of TRANSLATABLE_ATTRIBUTES) {
    const value = element.getAttribute(attr)?.trim();
    if (value) tokens.push(normalizeMarkupPlaceholders(value));
}
```

It iterates the configured list and pulls each value by name. `element.attributes` is never
enumerated, so **attribute order in the author's source cannot affect the id** — the same
property PHP has. `<img title alt>` and `<img alt title>` produce identical tokens in both.

**And `value` sits after all 15 in JS too**, matching PHP: the constant loop runs first, then
`VALUE_TRANSLATABLE_ELEMENTS` (`<button>`), then the `<input type=submit|button>` case
(`:362-372`). So §9's list parity extends to emission order for the attributes both
implementations share.

This was the right question to ask — it just happens to come back clean. The remaining
attribute-side risk is not ordering but **coverage**: PHP's list has 12 entries JS does not,
so any element carrying one of those twelve tokenizes differently. That is #7's territory, not
#11's, and it is a real divergence where this one was not.

Added by the base SDK owner, from the walker's actual behaviour
(`src/content-block.ts:313-395`) — these are the places three implementations can plausibly
disagree while each looks right in isolation:

- **Token ORDER is part of the identity, not just the set. [VERIFIED]** `generateCustomId`
  hashes `JSON.stringify([category, tokens])` (`:162-164`), so a set-equal but
  order-different array yields a different id. The JS walker emits, per element:
  **attributes first, then children** (`_tokenizeAttributes` at `:334-335` precedes the
  recursive descent at `:345`), depth-first in document order. A DOM walk that emits
  attributes after text is a conformant-looking implementation that fragments every catalog
  containing an `alt` or a `placeholder`. **Fixtures must assert the array, never a set.**
- **An excluded or `<Phrase>`-marked element loses its ATTRIBUTES too. [VERIFIED]** The
  exclusion check returns before `_tokenizeAttributes` (`:322-329`), so `translate="no"` on an
  `<img alt="...">` drops the `alt` as well as the subtree. Easy to implement as
  "skip children" and be wrong only on attribute-bearing nodes.
- **`&nbsp;` (U+00A0) — ANSWERED, and the two implementations diverge. [VERIFIED]** JS
  normalises text tokens with `.replace(/\s+/g, ' ').trim()` (`:338`) and JS `\s` matches
  U+00A0. PHP's `normalizeWhitespace()` is `trim(preg_replace('/\s+/', ' ', $text))`
  (`src/Html/HtmlParser.php:427-431`) — **no `/u` modifier**, so PCRE `\s` is ASCII-only, and
  PHP's `trim()` default charlist does not contain U+00A0 either. **PHP retains it.** Executed
  against `a76ed1a`:

  | input | PHP tokens | JS tokens | |
  |---|---|---|---|
  | `<p>Hello&nbsp;world </p>` | `["Hello\u00A0world"]` | `["Hello world"]` | content differs |
  | `<p>a&nbsp;&nbsp;b</p>` | `["a\u00A0\u00A0b"]` | `["a b"]` | JS collapses the run, PHP keeps both |
  | `<p>&nbsp;</p>` | `["\u00A0"]` | `[]` | **token count differs** |
  | `<p> </p>` — control | `[]` | `[]` | ASCII whitespace agrees |

  The trailing ASCII space in row 1 *is* trimmed by PHP, so the rule is not "PHP does not
  trim" — it is **PHP normalises ASCII whitespace only**.

  Row 3 is the sharp one: `&nbsp;` as a spacer between inline elements is ordinary authored
  markup, and it changes the **length** of the array, not a character inside one. Row 1 is the
  insidious one — real output from the probe:

  ```
  PHP tokens  = ["Hello world"] -> f753ffd212d0acaab04940c664790ef2
  JS  tokens  = ["Hello world"] -> fa08a023b349e0f2992d7e66a5baee9d
  ```

  Those two arrays are byte-different and **render identically in every log line, every diff,
  and every translator UI**. A fragmentation whose only evidence is invisible at every point a
  human would look is worth more than one fixture.

  **[OPEN] — and it is Darryl's call, not an SDK owner's.** Neither behaviour is obviously
  right, so §1's "PHP is presumed correct" does not settle it:

  - JS's collapse is right for **identity**: `Hello world` and `Hello&nbsp;world` are visually
    identical and should not be two catalog entries a translator cannot tell apart.
  - PHP's retention is right for **typography**: U+00A0 is authored intent (`5&nbsp;km`,
    French punctuation spacing), and collapsing it reintroduces a line-break opportunity the
    author deliberately removed.

  The third option is the only one right on both counts: normalise for the **key**, preserve
  for the **render**. That is a change to both implementations. Whichever is chosen, changing
  PHP's normaliser orphans every existing catalog entry containing a U+00A0 — the
  `generateLegacyCustomId` situation exactly, which is why it wants deciding before this
  package emits its first token rather than after.
- **There are already TWO tokenizers in the base SDK, and only one is registerable.**
  `tokenizeElement` (`:265-270`) and `legacyTokenizeElement` (`:288-292`) call the same walker
  with different flags — `duplicateSelectOptions` and `applyStyles`. The legacy one exists
  because `<select>` option text was harvested twice before 0.6.3. **Registration always uses
  the corrected list; the legacy list is lookup-only fallback.** A new implementation must
  produce the *corrected* tokens and should be able to produce the legacy ones for fallback
  reads, or it will silently orphan pre-0.6.3 blocks. Fixture both.
- **`tokens` and `content` have different portability.** `tokenizeElement` returns both;
  `content` inlines computed styles from the **live, mounted** element and "silently no-ops"
  pre-mount (`:261-263`). So a block first registered by *this* package arrives at the
  Translation Manager with an unstyled snapshot, where the same block registered from a
  browser arrives styled. **Tokens and `custom_id` are unaffected** — this is a translator-UX
  divergence, not an identity one, but it will be visible to humans and should be a stated,
  accepted consequence rather than a surprise.
- Comment nodes, CDATA, and text nodes that normalise to the empty string (dropped at `:339`,
  not emitted as `""`).

Added by the PHP owner, all measured against `a76ed1a` by execution:

- **Attributes precede children in PHP too. [VERIFIED]** `<p title="ATTR">CHILD</p>` →
  `["ATTR","CHILD"]`; `<div title="OUTER"><p title="IN">T</p></div>` → `["OUTER","IN","T"]`.
  Agrees with the JS walker. Recorded as a positive result so the agreement is on the record
  rather than assumed.

- **PHP emits attributes in CONFIGURED-LIST order, not document order. [VERIFIED]**
  `extractAttributePhrases()` iterates `$this->translatableAttributes` and tests
  `hasAttribute()` (`src/Html/HtmlParser.php:361-370`), so `<img title="T" alt="A">` and
  `<img alt="A" title="T">` both yield `["A","T"]` and the identical `custom_id`
  `695fbdda9fa2898aebd1dc7e3f26f605`. **[OPEN]** — does the JS walker iterate the constant, or
  `element.attributes`? If it iterates the element, those two spellings produce **different**
  ids in JS and the **same** id in PHP, and the trigger is an author reordering two
  attributes: the least suspicious edit that exists. Fixture both orderings and assert they
  collapse to one id.

- **`value` sorts AFTER the 15 attributes in PHP. [VERIFIED]**
  `<button value="VAL" title="TIT">TXT</button>` → `["TIT","VAL","TXT"]`, because
  `extractAttributePhrases()` runs before `extractButtonValue()` (`:337`, `:340`).
  **[OPEN]** the JS array for that exact input. §9 establishes that the two *lists* match; it
  says nothing about where `value` sits in the emitted **order**, and order is identity.

- **PHP's attribute list is RUNTIME-MUTABLE, so `custom_id` is a function of configuration.
  [VERIFIED]** `addTranslatableAttributes()` and `setTranslatableAttributes()` are public API.
  Measured on `<div data-tooltip="Hi">x</div>`: the default parser gives `["Hi","x"]` →
  `4cd4584d7b0fafa87c91602ddc0686de`, and a parser configured with the JS 15 gives `["x"]` →
  `5fbbfbb278583ae24e591c231163866a`. Two PHP apps configured differently disagree with **each
  other**, not merely with JS. **A conformance suite must pin the attribute list as part of
  the fixture**, or it certifies whatever the runner happened to be configured with — a
  fixture that passes for a reason unrelated to the implementation, which is §10 again. This
  package should treat the list as a compile-time constant.

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

**Answered** by the base SDK owner — there is an existing precedent, so this is a
consistency question rather than an API question. `registerContentBlock` refuses **locally**
and never makes the call **[VERIFIED]**, `src/content-block.ts:216-221`:

```ts
if (configStore.key_type !== 'write') {
    if (configStore.debug) logger.log(`Skipping content block save (API key is ${...})`);
    return { status: true };   // caller still renders the cached translation
}
```

Two properties worth copying and one worth **not** copying:

- Copy: refuse locally, and return **success** so the render path is unaffected. A read-only
  key is a correct production configuration, not an error condition.
- Copy: `key_type` is discovered from the authorize response, not configured — so "is this a
  write key" is knowable before any registration attempt.
- **Do not copy the `if (debug)` gate.** That log is invisible in the default configuration,
  which is §10's failure class exactly, and §6.3 of this document already requires the
  opposite ("fire-and-forget, but not silent"). Log the refusal unconditionally, once per
  process rather than once per phrase.

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

**Partially answered** by the base SDK owner. The blocker is **not** the mount hook — it is
that seeding sits behind a network round-trip.

`init()` awaits `LangsysAppAPI.validate()` (`src/langsys-app.ts:109`) and only then seeds
(`:121-133`) **[VERIFIED]**. So even called at module scope, the seed lands after an `await`.
Moving the call earlier does not make it synchronous.

What makes this tractable: the two signals are **already public exports**, and seeding is only
three synchronous operations — stamp `__category__` into each category, inject
`__uncategorized__` if absent, then `sTranslations.set()` and `currentlyLoadedLocale.set()`.
No fetch is involved. `__category__` is a required field of `iTranslations`
(`src/types/translations.ts:11`) but **[VERIFIED]** no runtime code branches on its value — it
is written in four places and read in none — so the stamping is a shape obligation, not a
behavioural one.

**[PROPOSED]** Ask the base SDK for a synchronous `seedCatalog(catalog, locale)` export doing
exactly those three things and nothing else. It is additive, non-breaking, needs no version
coordination with `init()`, and it removes the reason to call `init()` early at all. A
consumer can approximate it today by setting the two exported signals directly, but that
bypasses the stamping and must not be recommended as the supported path.

**Still [OPEN]:** whether each framework can run that seed before its own hydration entry
point, which is a per-framework question this package cannot answer. Also note the seeding
defects below are **not** fixed as of `0.6.5` — a synchronous seed path should not inherit
them.

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

**Answered by the PHP owner — and the premise is wrong. [VERIFIED]** `langsys-php` has not
solved multi-worker cache inconsistency. **It has never had the problem**, and the reason does
not transfer.

PHP's memo is `Client::$translationsMemoryCache`, an ordinary **instance property**
(`src/Client.php:96`) — not a static. Under PHP-FPM the object dies with the
request, so the **only** cross-request tier is the shared one (file or Redis), and two workers
cannot hold different views of it. `LANGSYS_CACHE_DRIVER=redis` exists to share a cache
between *machines* and to survive a read-only filesystem. It was never a fix for a divergence,
because there was none to fix.

`Client` holds exactly one static, and it is worth looking at because it is this whole section
in miniature: `protected static $requirementsWarned = false` (`src/Client.php:175`), a
once-per-process latch so a runtime-requirement warning is not repeated. Under FPM
"once per process" is approximately "once per request" and the latch is nearly inert. Under a
persistent worker the same line means **the warning fires once at boot and never again** — the
semantics of the code change without the code changing. That is the shape to look for when
porting: not variables that are obviously shared, but variables whose *lifetime* was defined by
a runtime that ended every request for you.

So the lesson is not "add Redis". It is the structural rule PHP gets for free and Node does
not:

> Any in-process memo is **request-scoped**. The shared tier is the **only** cross-request
> tier. A five-minute process-lived memo sitting in front of a shared cache reintroduces
> exactly the inconsistency the shared cache was added to remove.

That is §3.1's rule arriving from a second direction — worth noticing, because a five-minute
catalog memo does not *look* like module-global state, and it is.

Two properties of PHP's shared tier worth copying, and one worth not:

- **Copy: expiry is stamped absolutely at write time**, into the shared artifact —
  `FileCache::set()` writes `time() + $ttl` (`src/Cache/FileCache.php:89-93`). Every reader of
  that key sees the same expiry instant, so workers expire **together** instead of drifting by
  however long each has been up. A per-process "cached at" clock is what makes propagation
  staggered; an absolute stamp inside the shared record is what makes it atomic.
- **Copy: invalidation targets the shared key.** `clearCache()` deletes it
  (`src/Client.php:670-671`), so one worker's invalidation is every worker's.
- **Do not copy: there is no single-flight.** `get()` takes no lock, so N workers missing the
  same key simultaneously all call the API. Harmless at PHP-FPM's concurrency; not harmless at
  Node's. One long-lived process should coalesce in-flight fetches per key.

**The caveat that inverts the framing:** PHP's immunity is a property of the **deployment
model**, not of the code. Run this identical SDK under FrankenPHP worker mode, Swoole or
RoadRunner — long-lived PHP workers that reuse the `Client` — and it has the PM2 bug exactly.
§1's "PHP is presumed correct" therefore holds here for the wrong reason: PHP is not correct
about multi-worker caching, it has simply never been asked. Do not read its architecture as a
validated answer to a question it has not faced.

**Independently confirmed against the published Packagist artifact** (`langsys/langsys-php@v1.3.1`,
a different source from the working tree the finding came from). The asymmetry is sharper than
"one string is missing":

| Predicate | Defined | Call sites |
|---|---|---|
| `isTranslationExcluded` | `src/Html/HtmlParser.php:214` | **five** — including `MarkupTokenizer.php:79` and `Client.php:1075` |
| `isPhraseMarked` | `src/Html/HtmlParser.php:289` | **one** — `PageTranslator.php:336` |

The exclusion predicate is wired into the tokenizer path. The phrase-marker predicate is not.
`data-ls-phrase` appears nowhere in `src/`.

> **The lesson for anyone extending this protocol: mirrored predicates are not a symmetric
> contract.** Both SDKs implement `isPhraseMarked()` byte-for-byte identically, and that
> equivalence is documented, checked and real. It says nothing about whether either SDK *calls*
> it in the path that computes identity — and only call sites affect identity. §4 of this
> document originally asserted an interoperable marker contract on exactly that reasoning: two
> matching predicates, therefore a working handshake. The predicates matched. The handshake did
> not exist.

**[OPEN]** remains for the *policy*: a cache-busting signal from the Translation Manager would
beat any TTL, but it is Translation Manager surface, not this package's.

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

**Transcription confirmed** by the base SDK owner: the 15 attributes above match
`TRANSLATABLE_ATTRIBUTES` at `src/content-block.ts:48-64` exactly, in that order, and the
`value` note matches `VALUE_TRANSLATABLE_ELEMENTS = ['button']` and
`VALUE_TRANSLATABLE_INPUT_TYPES = ['submit', 'button']` (`:129-130`). **[VERIFIED]**

**Answered by the PHP owner: the 15 match exactly, in order — and PHP carries 12 more.
[VERIFIED]** by executing `getTranslatableAttributes()` at `a76ed1a`, not by reading the
constant. Indices 0–14 of PHP's list are the 15 above, in the identical order. Then:

```
data-confirm, data-tooltip, data-title, data-content, data-original-title,
data-bs-title, data-bs-content, data-loading-text, data-success-message,
data-warning-message, data-empty-message, data-placeholder
```

27 total. They are framework conventions — Bootstrap, Rails/Laravel `data-confirm` — that a
server-rendered PHP page routinely contains.

**This is a live divergence, not a footnote.** The dangerous direction is §7's hand-off, where
one DOM is walked by both: a block containing `data-tooltip` tokenizes to `["Hi","x"]` in PHP
and `["x"]` in JS — ids `4cd4584d…` and `5fbbfbb2…`, measured in §5. Same page, same element,
two catalog entries.

Flagged rather than merged, per the instruction. The owner's choice is not symmetric:

- **JS adopts the 12** — identity converges, and every JS content block whose subtree contains
  one of those attributes changes id. A catalog migration.
- **PHP drops the 12** — the same migration on the PHP side, and PHP users lose coverage they
  have today.
- **Neither** — the divergence is documented and the hand-off keeps fragmenting.

### DECIDED — converge on PHP's 27

Darryl's call, 2026-08-21. **PHP's list is the contract. JS adopts the 12.**

**Corrected 2026-08-21 by the builder, who re-ran the premise instead of inheriting it (rule 6).**
This section previously said "this package implements all 27" three paragraphs above a constraint
saying it "must not ship 27 before the client SDKs do." **Both cannot be actioned today**, and the
contradiction was mine. The published `langsys-js-typescript@0.6.5` carries exactly the 15 — all
twelve PHP-only names occur **zero** times in `dist/index.mjs` — and the base SDK has the
convergence in `ROADMAP.md` as **Not started**, blocked on the migration count.

So the resolution is: **27 is the contract; this package implements whatever the client family
currently ships, and moves with it.** That is 15 today, behind a base-SDK version floor, becoming
27 when the base SDK ships the 12. Implementing 27 ahead of the client family would make this
package agree with PHP and disagree with the client it hands off to on **every request** — the
worse trade, since the hand-off is per-request and PHP interop is deployment-topology.

The divergence that remains is documented rather than discovered: any block carrying one of the
twelve tokenizes differently here than in PHP until the convergence lands.

Worth recording alongside it, because it is the strongest argument for the decision and neither
this document nor the discussion that produced it had stated it: the base SDK's own
`content-block.ts` documents the 15 as a **considered choice** — framework-convention attributes
"are written by server-rendered templates, and a JS app renders those strings through its own
components instead." Their roadmap then names exactly why that no longer holds:

> A JS package that renders HTML server-side is the case the comment excludes. Converging on 27
> is not overriding a considered decision carelessly — it is **a decision whose premise expired.**

That inverts the recommendation directly above, and the inversion is the point: "implement the
15" was correct *while JS had 15*, because §7's hand-off is a per-request event and PHP interop
is a deployment-topology one. Once the client family carries 27, the trade disappears —
implementing 27 agrees with both.

**Mechanically the convergence is clean, and that was checked rather than assumed**, because
token order is `custom_id` identity. Read back from `langsys-php@v1.3.1`
`src/Html/HtmlParser.php:26-60` and `langsys-js-typescript@0.6.5` `dist/index.mjs:1138`: the 15
are identical *and in identical order*, and PHP's extra 12 sit in one contiguous block after
them. So JS appends and **nothing already in the list moves.** Had PHP interleaved its extras,
every block carrying any translatable attribute would have re-keyed instead of only those
carrying one of the twelve.

`value` continues to be emitted after the whole constant loop — then `<button>`, then
`<input type=submit|button>` — which is already true in both and stays true with a longer list.

**Sequencing, and it is a real dependency.** This package must not ship 27 before the client
SDKs do, or it disagrees with its own hand-off partner on every request — the exact trade the
paragraph above warned about, just pointed the other way. Either the base SDK ships the 12
first, or this package pins a base-SDK version floor that guarantees them. **Do not treat the
decision as permission to implement ahead of the dependency.**

**[OPEN] — the migration, which is the real cost and is not this package's call.** A
JS-registered block whose subtree carries any of the twelve changes `custom_id` when this ships,
orphaning its catalog entry.

**The blast radius is narrow and, crucially, it is queryable.** A block re-keys **only** if its
subtree carries one of the twelve *with a non-empty value*; every other block's `tokens[]` is
byte-identical and its `custom_id` unchanged. So the affected set is exactly: content blocks
whose stored `content` HTML contains any of the twelve attribute names.

That turns the decision from a judgement about deprecation debt into a **lookup**. Get the count
out of the Translation Manager before choosing a mechanism — "carry a fallback indefinitely" and
"rebase once" have very different prices at 4 blocks than at 4,000, and nobody who has discussed
this so far has the number.

**A distinction worth preserving when describing the debt.** A fallback added here would *not*
be a second `generateLegacyCustomId`. That one exists because the **hash input encoding** changed
(`tokens.join('-')` → `JSON.stringify`), which is why its doc comment insists on reasoning about
the final hashed string rather than the phrase. This would instead be the *same*
`generateCustomId` applied over a **shorter attribute list** — a second token *derivation*, not a
second hash.

Both are links in a chain, and a chain is harder to retire than either link. But they are links
of different kinds, and calling both "a legacy id" would make the eventual retirement harder to
reason about than it needs to be: retiring the encoding fallback requires rebasing every block,
while retiring a derivation fallback requires rebasing only blocks carrying those attributes.

**One constraint this package should adopt regardless:** PHP's list is runtime-mutable via
`setTranslatableAttributes()`, which makes `custom_id` a function of *configuration* rather than
of content. **Do not expose a runtime setter here.** A server SDK whose id generation depends on
host configuration reintroduces precisely the divergence this decision removes — and the
conformance suite must pin the list explicitly for the same reason, or it certifies whatever the
runner happened to be configured with and reports that as parity.

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
8. **A cited line number is not evidence until something reads it back.** Contributed by the
   base SDK owner, who re-ran their own citations before committing and found six off by a few
   lines, then found four in `langsys-skill` that had already shipped. The PHP owner then found
   two of their own the same way — including a pair pointing at the *comment lines above* the
   calls, off by one, in the direction that reads plausibly.

   Auditing all fifteen citations in `langsys-skill`'s `VERIFIED.md` split cleanly: **11 of 11
   derived by grepping the artifact directly were correct; 4 of 4 inherited from a peer's
   message were wrong.** But the PHP owner's framing is the better one, because theirs were not
   inherited — they generated both, minutes apart, from files they had open:

   > A line number is a claim you make in passing while your attention is on the argument, so
   > it never gets the scrutiny the argument gets.

   That covers both failures. Read every citation back, including your own, and especially the
   ones you wrote while thinking about something else.
9. **A grep hit is not a reading.** While verifying §4, this document's author found
   `data-ls-phrase` in the published PHP package and briefly concluded its README claimed
   support the code did not implement. Reading the surrounding sentence showed the opposite —
   it was correctly describing what the *JS* SDK must recognise. The string matched; the claim
   was the reverse of what the match suggested. One sentence of context was the whole
   difference between a real finding and a fabricated defect report.

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
| 1 | ~~Is ALS-based scoping sufficient, or does other module state leak per request?~~ **ANSWERED §3.1.** `persist()` is clean; five other pieces of module state leak, incl. the API auth header. Importing the base SDK at all instantiates the singleton graph. | §3.1 | base SDK ✅ |
| 2 | **Vue ANSWERED §5 by execution.** Yes, via `async setup()` + a throwaway app. Genuinely async (sync machinery exists internally, unexported). Two string divergences — fragment anchors and **entity escaping** — both belonging in the core's canonicalization, with decoded text as the normative form. The finding that matters: **component-level `provide()` does not cross a nested render**, which is a constraint on the consuming app, not on the adapter. React and Svelte still open, and the question to ask them is **context propagation**, not async. | §3.3 | React owner (Svelte + Vue ✅) |
| 3 | Can the tokenizer produce byte-identical tokens from an HTML string as from a DOM? Prove on fixtures before committing. | §5 | this package + PHP |
| 4 | ~~Should registration be attempted under a read-only key?~~ **ANSWERED §6.** Refuse locally, return success, log unconditionally (the SDK's own precedent gates the log on `debug` — do not copy that). | §6 | base SDK ✅ |
| 5 | Can client SDKs seed synchronously before hydration? **PARTIALLY ANSWERED §7** — the blocker is that `init()` seeds *after* `await validate()`, not the mount hook. A `seedCatalog()` export is proposed. Per-framework hydration timing is still open. | §7 | client SDKs |
| 6 | ~~What should this package do about multi-worker cache inconsistency? What does PHP already do?~~ **ANSWERED §8 — the premise was wrong.** PHP has never had the problem: its memo is an instance property and FPM ends the request. The rule is "request-scoped memo, shared tier is the only cross-request tier", not "add Redis". Policy sub-question (a bust signal from the Translation Manager) stays open. | §8 | PHP ✅ |
| 7 | ~~Do the JS and PHP attribute lists match?~~ **DECIDED 2026-08-21 — converge on PHP's 27.** The 15 are identical and in identical order; PHP's 12 append contiguously, so nothing already in the list moves. This package implements 27, but **not before the client SDKs do**. The migration stays open: JS blocks carrying any of the 12 re-key — second legacy generation, or rebase? | §9 | Darryl ✅ / base SDK |
| 8 | `-server` or `-node`? | §11 | Darryl |
| 9 | **NEW.** How does this package consume the base SDK's pure functions without importing its singleton graph — vendor-with-conformance-test, or request `sideEffects: false` + a `/pure` subpath export? | §3.1 | base SDK + this package |
| 10 | ~~Does PHP's tokenizer retain `&nbsp;` (U+00A0)?~~ **ANSWERED §5 — yes, they diverge.** PHP normalises ASCII whitespace only; a bare `&nbsp;` text node is a token in PHP and absent in JS, so the token *count* differs. Which behaviour wins is a product decision, not an SDK one. | §5 | PHP ✅ / Darryl |
| 11 | ~~Does the JS walker iterate the constant or `element.attributes`?~~ **ANSWERED §5 — clean.** JS iterates `TRANSLATABLE_ATTRIBUTES` by name, so source attribute order cannot affect the id, and `value` is emitted after all 15. Matches PHP on both counts. The attribute-side risk is #7's coverage gap, not ordering. | §5 | base SDK ✅ |
| 12 | `data-ls-phrase` is unrecognised by `langsys-php`, and PHP's `isPhraseMarked()` is never called by PHP's tokenizer. Which spelling does this package emit, and does PHP learn the JS one? **JS side answered §4: reading accepts both spellings, the marker never enters `tokens[]`, so emitting both is free.** Whether PHP learns the JS spelling stays open. | §4 | PHP + Darryl |

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

### How to record your pass

This document is edited by several agents in sequence, and the record of *who changed what*
is part of its value — a later reader needs to know whether a claim came from the package
that owns the code or from someone reasoning about it from outside.

So:

1. **Edit the document directly.** It is shared, not anyone's draft to defend.
2. **Commit your own pass, alone.** One commit per reviewer, containing only that reviewer's
   changes. Do not fold your edits into someone else's commit or leave them uncommitted for
   the next reviewer to inherit.
3. **Name yourself in the commit subject** — e.g. `Base SDK review pass: …`.
4. **Say what you changed and why in the body**, especially any `[VERIFIED]` tag you removed
   or downgraded. A tag that was wrong is more important to record than a section that was
   added.
5. **Add a row below** before you finish.

If you find you have nothing to change, commit nothing and say so — an empty pass is a real
result and should not be disguised as a review.

### Passes

| Date | Reviewer | What changed |
|---|---|---|
| 2026-08-21 | `langsys-skill` agent | Initial draft from the SSR design discussion |
| 2026-08-21 | `langsys-js-typescript` agent (base SDK) | Answered open questions #1 and #4; partially answered #5. Corrected two wrong `[VERIFIED]` citations in §3.4 and one in §1. Added seven tokenizer-parity fixture requirements to §5, incl. token *ordering* as part of `custom_id` identity. Confirmed §9's attribute list against source. Raised two new open questions (#9, #10). |
| 2026-08-21 | `langsys-php` agent (reference impl.) | Answered #6, #7 and #10 by **executing** the PHP tokenizer, not reading it. #10: PHP retains U+00A0 — the arrays print identically and hash differently. #6: the premise was wrong, PHP never had the multi-worker problem. #7: 15 match in order, PHP has 12 more. Corrected §4 — `data-ls-phrase` is unrecognised in PHP and `isPhraseMarked()` is never called by PHP's tokenizer. Added four PHP-side parity constraints to §5 incl. the runtime-mutable attribute list. Qualified §1's "PHP is presumed correct" tiebreak, which this pass breaks twice. Raised #11 and #12. |
| 2026-08-21 | `langsys-js-typescript` agent (base SDK, 2nd pass) | Answered #11: **clean** — the JS walker iterates the `TRANSLATABLE_ATTRIBUTES` constant by name, not `element.attributes`, so source attribute order cannot affect the id, and `value` is emitted after all 15. Matches PHP on both counts. Answered the JS half of #12: `isPhraseMarked()` accepts both spellings with identical opt-out semantics, and the marker never enters `tokens[]`, so emitting both costs nothing on identity. |
| 2026-08-21 | `langsys-skill` agent (final review) | Independently confirmed §4's marker asymmetry against the **published Packagist artifact** rather than the working tree it came from — `isTranslationExcluded` has five call sites including the tokenizer, `isPhraseMarked` has one and is not in the identity path. Named the structural lesson: mirrored predicates are not a symmetric contract, which is the reasoning §4 originally rested on. Added §5 sequencing — the first divergent fixture is blocked on decisions #10/#11/#12, because a fixture here encodes a decision rather than records a fact. Added rules 8 and 9 to §10. Restored review-log chronology. |
