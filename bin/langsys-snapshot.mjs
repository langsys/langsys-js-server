#!/usr/bin/env node
/**
 * Export a catalog snapshot (spec SNAP-1): the project's catalog for one or more locales,
 * filtered by category, as a `langsys-catalog-snapshot` v1 document any SDK loads.
 *
 *   langsys-snapshot --locale <locale>... [--category <name>]... [--out <file>]
 *
 * A snapshot is a cache the catalog produced (SNAP-3): refresh it by running this again, never by
 * editing it — its checksum makes an edited file fail to load. Configuration comes from LANGSYS_PROJECT_ID, LANGSYS_API_KEY, LANGSYS_BASE_LOCALE
 * (default en) and LANGSYS_API_URL.
 */
import { writeFileSync } from 'node:fs';
import { createLangsysServer } from '../dist/index.mjs';

const args = process.argv.slice(2);
const value = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
const locales = value('--locale');
const categories = value('--category');
const [out] = value('--out');
const env = process.env;
if (!locales.length || !env.LANGSYS_PROJECT_ID || !env.LANGSYS_API_KEY) {
    console.error('usage: langsys-snapshot --locale <locale>... [--category <name>]... [--out <file>]  (needs LANGSYS_PROJECT_ID and LANGSYS_API_KEY)');
    process.exit(2);
}
const langsys = createLangsysServer({
    projectId: env.LANGSYS_PROJECT_ID,
    apiKey: env.LANGSYS_API_KEY,
    baseLocale: env.LANGSYS_BASE_LOCALE ?? 'en',
    ...(env.LANGSYS_API_URL ? { apiUrl: env.LANGSYS_API_URL } : {}),
    harvest: false,
    flushOnExit: false,
});
try {
    const snapshot = await langsys.exportSnapshot(locales, categories.length ? categories : undefined);
    const json = JSON.stringify(snapshot, null, 2) + '\n';
    if (out) writeFileSync(out, json);
    else process.stdout.write(json);
} catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
}
