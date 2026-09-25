#!/usr/bin/env node
/**
 * List, check and register every server message template an app declares (spec MSG-7).
 *
 *   langsys-messages <declarations module> [--register]
 *
 * The module's default export (or its `templates` export) is an array of templates, each a string
 * or `{ template, where }`, where `where` names the file, class or field it came from. Every
 * template is printed; a template that breaks the template rules is printed with where it came
 * from and the fix, and makes the command exit 1 — so a message that cannot be registered ahead
 * of time fails the build instead of reaching a user untranslated. With --register, templates
 * the project's catalog does not already list are registered; a second run registers nothing.
 *
 * Configuration comes from LANGSYS_PROJECT_ID, LANGSYS_API_KEY, LANGSYS_BASE_LOCALE (default en),
 * LANGSYS_API_URL and LANGSYS_MESSAGE_CATEGORY (default Errors).
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createLangsysServer } from '../dist/index.mjs';

const args = process.argv.slice(2);
const register = args.includes('--register');
const target = args.find((a) => !a.startsWith('--'));
if (!target) {
    console.error('usage: langsys-messages <declarations module> [--register]');
    process.exit(2);
}

const mod = await import(pathToFileURL(resolve(target)).href);
const declared = mod.templates ?? mod.default;
if (!Array.isArray(declared)) {
    console.error(`${target}: export an array of templates as default or as \`templates\``);
    process.exit(2);
}

const env = process.env;
if (register && (!env.LANGSYS_PROJECT_ID || !env.LANGSYS_API_KEY)) {
    console.error('--register needs LANGSYS_PROJECT_ID and LANGSYS_API_KEY');
    process.exit(2);
}
const langsys = createLangsysServer({
    projectId: env.LANGSYS_PROJECT_ID ?? 'unset',
    apiKey: env.LANGSYS_API_KEY ?? 'unset',
    baseLocale: env.LANGSYS_BASE_LOCALE ?? 'en',
    ...(env.LANGSYS_API_URL ? { apiUrl: env.LANGSYS_API_URL } : {}),
    ...(env.LANGSYS_MESSAGE_CATEGORY ? { messageCategory: env.LANGSYS_MESSAGE_CATEGORY } : {}),
    harvest: false,
    flushOnExit: false,
});

const { templates, problems, registered } = await langsys.registerTemplates(declared, { register });
for (const t of templates) console.log(t);
for (const p of problems) console.error(`PROBLEM ${p.where ? `${p.where}: ` : ''}${p.template ? JSON.stringify(p.template) : ''} — ${p.problem}`);
console.log(`${templates.length} template(s), ${problems.length} problem(s)${register ? `, ${registered.length} registered under ${langsys.messageCategory}` : ''}`);
process.exit(problems.length ? 1 : 0);
