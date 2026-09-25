/**
 * Standalone mock of the Langsys API.
 *
 * The example must run offline and deterministically — a test that depends on a live
 * translation backend measures the network as much as the package, and a flaky
 * acceptance test gets muted, which is worse than not having one.
 *
 * This speaks the real API shape, verified against `langsys-js-typescript@0.6.5`
 * `dist/index.mjs:88-133`:
 *
 *     GET  /api/authorize-project/{id}   -> { status, data: { key_type } }
 *     GET  /api/translations?project_id&locale -> { status, data: <catalog> }
 *     POST /api/translatable-items       -> { status }
 *
 * It also RECORDS what was registered, so tests can assert on harvesting rather than
 * inferring it from logs.
 *
 *     node mock-api/server.mjs [port]
 */

import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? process.env.MOCK_API_PORT ?? 5571);

/**
 * Fixture catalogs.
 *
 * `it` and `de` deliberately share phrase keys so a cross-request leak is VISIBLE:
 * if a /de render ever emits Italian, the assertion is a string compare, not a subtle
 * one. `ru` exists because Russian has more than two plural forms, which is the case
 * §13.2 names and the one a base-language eyeball test cannot catch.
 */
const CATALOGS = {
    it: {
        __uncategorized__: {
            'Hydration begins with better water.': "L'idratazione inizia con un'acqua migliore.",
            'Shop now': 'Acquista ora',
            'Read the guide': 'Leggi la guida',
            'Welcome back, {name}': 'Bentornato, {name}',
            'A glass of water': "Un bicchiere d'acqua",
        },
        marketing: {
            'Trusted by professionals': 'Scelto dai professionisti',
        },
    },
    de: {
        __uncategorized__: {
            'Hydration begins with better water.': 'Hydratation beginnt mit besserem Wasser.',
            'Shop now': 'Jetzt einkaufen',
            'Read the guide': 'Zum Ratgeber',
            'Welcome back, {name}': 'Willkommen zurück, {name}',
            'A glass of water': 'Ein Glas Wasser',
        },
        marketing: {
            'Trusted by professionals': 'Von Profis empfohlen',
        },
    },
    ru: {
        __uncategorized__: {
            'Hydration begins with better water.': 'Гидратация начинается с лучшей воды.',
            'Shop now': 'Купить сейчас',
            'Read the guide': 'Читать руководство',
            'Welcome back, {name}': 'С возвращением, {name}',
            'A glass of water': 'Стакан воды',
            // More than two plural forms. A flat template renders fine in English, which
            // is exactly why this has to be asserted rather than eyeballed.
            '{n, plural, one {# bottle} other {# bottles}}':
                '{n, plural, one {# бутылка} few {# бутылки} many {# бутылок} other {# бутылки}}',
        },
        marketing: {
            'Trusted by professionals': 'Нам доверяют профессионалы',
        },
    },
};

/** Everything POSTed to translatable-items, so tests can assert on harvesting. */
const registered = [];
/** Per-locale catalog fetch counts, so tests can assert on caching and single-flight. */
const fetchCounts = {};

let keyType = process.env.MOCK_KEY_TYPE ?? 'write';
/** Artificial latency, so tests can force renders to interleave. */
let latencyMs = Number(process.env.MOCK_LATENCY_MS ?? 0);

const json = (res, body, status = 200) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
};

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    // ---- test control surface (not part of the real API) ----
    if (path === '/__test__/registered') return json(res, { registered });
    if (path === '/__test__/fetch-counts') return json(res, { fetchCounts });
    if (path === '/__test__/reset') {
        registered.length = 0;
        for (const k of Object.keys(fetchCounts)) delete fetchCounts[k];
        return json(res, { ok: true });
    }
    if (path === '/__test__/key-type') {
        keyType = url.searchParams.get('value') ?? 'write';
        return json(res, { ok: true, keyType });
    }
    if (path === '/__test__/latency') {
        latencyMs = Number(url.searchParams.get('ms') ?? 0);
        return json(res, { ok: true, latencyMs });
    }

    // ---- the real API shape ----
    if (path.startsWith('/api/authorize-project/')) {
        return json(res, { status: true, data: { key_type: keyType, base_locale: 'en', target_locales: ['it', 'de', 'ru'] } });
    }

    if (path === '/api/translations') {
        const locale = url.searchParams.get('locale') ?? '';
        fetchCounts[locale] = (fetchCounts[locale] ?? 0) + 1;
        if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
        return json(res, { status: true, data: CATALOGS[locale] ?? {} });
    }

    if (path === '/api/translatable-items' && req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            registered.push(...(body.translatable_items ?? []));
        } catch {
            return json(res, { status: false, errors: ['bad json'] }, 400);
        }
        return json(res, { status: true });
    }

    json(res, { status: false, errors: [`no mock route for ${req.method} ${path}`] }, 404);
});

server.listen(PORT, () => {
    console.log(`[mock-api] listening on http://localhost:${PORT} (key_type=${keyType})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
}
