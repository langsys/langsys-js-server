/**
 * Client-DOM parity probe.
 *
 * ============================================================================
 * WHAT THIS MEASURES, AND WHY IT IS THE ONE THING NOTHING ELSE COVERS
 * ============================================================================
 *
 * `custom_id` identity has two halves. This repo's conformance suite covers one of
 * them exhaustively:
 *
 *     [A] server HTML string  ->  tokens     (langsys-js-server's tokenizer)
 *     [B] server HTML in a DOM ->  tokens     (langsys-js-typescript's DOM walker)
 *     A == B  ..................................  60+ cases, mutation-tested, green
 *
 * The half nobody has measured is what happens AFTER the framework hydrates:
 *
 *     [C] the LIVE, HYDRATED DOM -> tokens
 *     B == C  ..................................  UNMEASURED
 *
 * It is not obviously equal. Hydration is free to restructure text nodes, and the
 * base SDK's walker does NOT coalesce adjacent text nodes — each is its own token —
 * so a framework that splits or merges a text run during hydration changes the token
 * ARITY, which changes `custom_id`, which silently re-keys the block.
 *
 * The two known asymmetries, both from the framework owners' own measurements:
 *   - React emits `<!-- -->` exactly where it has adjacent text children, so its
 *     server bytes are an isomorphism of its client text-node structure. Good.
 *   - Svelte's captured text runs stay WHOLE server-side. If Svelte's client DOM
 *     splits where its server string does not, the Svelte path has React's problem
 *     in mirror image — and Svelte is the reference deployment's framework.
 *
 * This probe answers B == C by running the SAME tokenizer over both, in one browser,
 * on one page. It fetches the page's own served bytes, parses them into a detached
 * DOM (which is [B] — bytes, never hydrated), walks to the same element in the live
 * tree (which is [C]), and diffs.
 *
 * ============================================================================
 * HOW TO RUN IT
 * ============================================================================
 *
 * In the browser devtools console, on a hydrated page, in a non-base locale:
 *
 *     // 1. Get the REAL tokenizer. Do not reimplement it — lifting it out of the
 *     //    installed dist is the whole point, and a reimplementation would be
 *     //    checking this probe against itself.
 *     const sdk = await import('langsys-js-typescript');   // works under Vite dev
 *
 *     // 2. Paste this file, then:
 *     await langsysClientDomParity({ sdk });
 *
 * If the bare import fails (a production build with no module graph exposed), add a
 * temporary dev-only route or module that does
 * `window.__LANGSYS_SDK__ = await import('langsys-js-typescript')`, load it, and pass
 * `{ sdk: window.__LANGSYS_SDK__ }`.
 *
 * Options:
 *     selector  extra CSS selector for subtrees to check beyond marker-carrying ones
 *     verbose   log every element, not just mismatches
 *
 * The result object is JSON-serialisable — `copy(result)` and paste it back.
 */

/* eslint-disable no-console */
globalThis.langsysClientDomParity = async function langsysClientDomParity(options = {}) {
    const { sdk, selector, verbose = false } = options;

    if (!sdk || typeof sdk.tokenizeElement !== 'function') {
        throw new Error(
            'Pass the REAL SDK: await langsysClientDomParity({ sdk: await import("langsys-js-typescript") }). ' +
                'This probe deliberately does not bundle its own tokenizer — a reimplementation ' +
                'would be checking the probe against itself rather than against the contract.',
        );
    }
    const { tokenizeElement, generateCustomId } = sdk;

    // ---------------------------------------------------------------- roots
    // Elements worth comparing: anything marked as a content block or a phrase, plus
    // whatever the caller names. Markers are the only reliable, framework-agnostic
    // signal of "this subtree's identity is hashed somewhere".
    const MARKERS = [
        '[data-langsys-contentblock]',
        '[data-ls-contentblock]',
        '[data-ls-phrase]',
        '[data-langsys-phrase]',
    ];
    const rootSelector = selector ? [...MARKERS, selector].join(',') : MARKERS.join(',');
    const liveRoots = Array.from(document.querySelectorAll(rootSelector));

    if (liveRoots.length === 0) {
        return {
            ok: false,
            reason:
                'No marker-carrying elements found on this page. That is a RESULT, not an error: ' +
                'it means nothing on this page registers a content block or a phrase, so there is ' +
                'no identity to compare. Try a page with a <Translate> or <Phrase> in it, or pass ' +
                '{ selector } to name subtrees explicitly.',
            url: location.href,
            checked: 0,
        };
    }

    // ------------------------------------------------------- served bytes [B]
    // Re-fetch this exact URL. `cache: 'reload'` so we measure what the server sends
    // now, not what a bfcache entry remembers. This is the same document the crawler
    // would receive.
    const response = await fetch(location.href, {
        cache: 'reload',
        headers: { Accept: 'text/html' },
    });
    const servedHtml = await response.text();
    const servedDoc = new DOMParser().parseFromString(servedHtml, 'text/html');

    // ------------------------------------------------------ locating the twin
    // Index path from <body>, counting ELEMENT children only. Element indices survive
    // hydration far better than text-node indices — which is precisely the thing under
    // test and therefore must not be used to do the locating.
    function elementPath(el) {
        const path = [];
        let node = el;
        while (node && node !== document.body && node.parentElement) {
            path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
            node = node.parentElement;
        }
        return node === document.body ? path : null;
    }

    function resolvePath(doc, path) {
        let node = doc.body;
        for (const index of path) {
            if (!node || !node.children[index]) return null;
            node = node.children[index];
        }
        return node;
    }

    // -------------------------------------------------------------- compare
    const results = [];
    let matched = 0;
    let mismatched = 0;
    let unresolved = 0;

    for (const liveEl of liveRoots) {
        const path = elementPath(liveEl);
        if (!path) {
            unresolved++;
            continue;
        }

        const servedEl = resolvePath(servedDoc, path);
        if (!servedEl) {
            // The element exists live but not in the served bytes: it was created by
            // client-side rendering. That is itself a finding — such a block never
            // appears in crawler-visible HTML at all.
            unresolved++;
            results.push({
                path: path.join('>'),
                status: 'client-only',
                note: 'Present in the hydrated DOM but absent from the served bytes — this content is not crawler-visible.',
                liveTag: liveEl.tagName.toLowerCase(),
                liveText: (liveEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
            });
            continue;
        }

        // Tag mismatch means the path resolved to a different element; comparing tokens
        // would produce a confident, meaningless diff.
        if (servedEl.tagName !== liveEl.tagName) {
            unresolved++;
            results.push({
                path: path.join('>'),
                status: 'path-drift',
                note: `Path resolved to <${servedEl.tagName.toLowerCase()}> in the served bytes but <${liveEl.tagName.toLowerCase()}> live. Not compared.`,
            });
            continue;
        }

        const category = liveEl.getAttribute('data-langsys-category') || liveEl.getAttribute('data-ls-category') || '';

        const liveTokens = tokenizeElement(liveEl).tokens;
        const servedTokens = tokenizeElement(servedEl).tokens;

        const same =
            liveTokens.length === servedTokens.length &&
            liveTokens.every((tok, i) => tok === servedTokens[i]);

        const entry = {
            path: path.join('>'),
            tag: liveEl.tagName.toLowerCase(),
            category,
            status: same ? 'match' : 'MISMATCH',
            servedTokens,
            liveTokens,
            servedCustomId: generateCustomId ? generateCustomId(category, servedTokens) : undefined,
            liveCustomId: generateCustomId ? generateCustomId(category, liveTokens) : undefined,
        };

        if (same) {
            matched++;
            if (verbose) results.push(entry);
        } else {
            mismatched++;
            // The arity difference is the headline: a changed token COUNT is the
            // signature of hydration splitting or merging a text run, which is the
            // specific failure this probe exists to detect.
            entry.arityChanged = liveTokens.length !== servedTokens.length;
            entry.firstDivergentIndex = servedTokens.findIndex((tok, i) => tok !== liveTokens[i]);
            results.push(entry);
        }
    }

    const summary = {
        ok: mismatched === 0,
        url: location.href,
        lang: document.documentElement.lang || null,
        checked: liveRoots.length,
        matched,
        mismatched,
        unresolved,
        results,
    };

    // Positive evidence that the probe ran and did real work. Without this, "no
    // mismatches" and "the probe never compared anything" print identically — which is
    // the failure class this whole project is downstream of.
    console.log(
        `%clangsys client-DOM parity%c  ${matched} matched, ${mismatched} MISMATCHED, ${unresolved} unresolved (of ${liveRoots.length} found)`,
        'font-weight:bold',
        '',
    );
    if (liveRoots.length > 0 && matched === 0 && mismatched === 0) {
        console.warn(
            'Found elements but compared none of them. Treat this as INCONCLUSIVE, not as a pass.',
        );
    }
    if (mismatched > 0) console.table(results.filter((r) => r.status === 'MISMATCH'));

    return summary;
};

/**
 * Self-check: run the probe's own logic against a case where the answer is known.
 *
 * Call `langsysClientDomParitySelfTest({ sdk })` BEFORE trusting a clean result. It
 * builds two detached trees that differ only in text-node arity and confirms the
 * tokenizer reports them as different. If this fails, a clean run above means the
 * comparison is broken, not that the page is correct.
 */
globalThis.langsysClientDomParitySelfTest = function selfTest({ sdk }) {
    const { tokenizeElement } = sdk;

    const merged = document.createElement('div');
    merged.appendChild(document.createTextNode('Hello Bob!'));

    const split = document.createElement('div');
    split.appendChild(document.createTextNode('Hello '));
    split.appendChild(document.createTextNode('Bob'));
    split.appendChild(document.createTextNode('!'));

    const mergedTokens = tokenizeElement(merged).tokens;
    const splitTokens = tokenizeElement(split).tokens;

    const discriminates = mergedTokens.length !== splitTokens.length;

    console.log('self-test  merged ->', JSON.stringify(mergedTokens));
    console.log('self-test  split  ->', JSON.stringify(splitTokens));
    console.log(
        discriminates
            ? '%cPASS%c the tokenizer distinguishes text-node arity, so a clean parity run is meaningful.'
            : '%cFAIL%c the tokenizer did NOT distinguish arity here. A clean parity run above proves nothing.',
        discriminates ? 'color:green;font-weight:bold' : 'color:red;font-weight:bold',
        '',
    );

    return { discriminates, mergedTokens, splitTokens };
};
