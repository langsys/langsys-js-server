/**
 * SRV-6: choose a request's locale — the URL, then a cookie, then `Accept-Language` — from the
 * locales the project serves, and say what the choice depended on.
 *
 * Every candidate is validated against the served set (the project's base and target locales,
 * from authorization); an unsupported one is skipped and never served. The returned `vary` is
 * what a response must name in `Vary` so a cache in front of the site does not serve one
 * visitor's language to the next: nothing for a URL locale, which is already the cache key;
 * `Cookie` for a cookie; `Cookie` and `Accept-Language` when resolution reached the header,
 * since a request carrying a different cookie or header would have been answered differently.
 */
import { canonicalizeLocale } from 'langsys-js-typescript/pure';

export interface ResolveLocaleOptions {
    /** The query parameter the app routes by, or `false`. Default `locale`. */
    queryParam?: string | false;
    /** The cookie the app keeps the locale in, or `false`. Default `locale`. */
    cookie?: string | false;
    /** Whether the first path segment names the locale (`/it/pricing`). Default `true`. */
    pathSegment?: boolean;
}

export interface ResolvedLocale {
    /** Canonical lowercase `xx` or `xx-yy`, always one the project serves. */
    locale: string;
    source: 'url' | 'cookie' | 'header' | 'base';
    /** Header names the response must list in `Vary`. */
    vary: string[];
}

/** Match a candidate to a served locale: exactly, then by language (`it-ch` → `it`, `de` → `de-de`). */
function match(candidate: string | undefined | null, served: readonly string[]): string | undefined {
    if (!candidate) return undefined;
    let wanted: string;
    try {
        wanted = canonicalizeLocale(candidate.trim());
    } catch {
        return undefined;
    }
    if (!wanted) return undefined;
    if (served.includes(wanted)) return wanted;
    const language = wanted.split('-')[0]!;
    if (served.includes(language)) return language;
    return served.find((s) => s.split('-')[0] === language);
}

function readCookie(header: string | null, name: string): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() !== name) continue;
        try {
            return decodeURIComponent(part.slice(eq + 1).trim());
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/** `Accept-Language` tags by preference, `q=0` (a refusal) and `*` dropped. */
function preferences(header: string | null): string[] {
    if (!header) return [];
    return header
        .split(',')
        .map((entry, index) => {
            const [tag, ...params] = entry.trim().split(';');
            const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
            return { tag: (tag ?? '').trim(), q: q ? Number(q.slice(2)) : 1, index };
        })
        .filter((p) => p.tag && p.tag !== '*' && Number.isFinite(p.q) && p.q > 0)
        .sort((a, b) => b.q - a.q || a.index - b.index)
        .map((p) => p.tag);
}

export function resolveRequestLocale(
    request: Request,
    served: readonly string[],
    baseLocale: string,
    options: ResolveLocaleOptions = {},
): ResolvedLocale {
    const { queryParam = 'locale', cookie = 'locale', pathSegment = true } = options;
    const url = new URL(request.url);

    const fromUrl =
        (pathSegment ? match(url.pathname.split('/')[1], served) : undefined) ??
        (queryParam ? match(url.searchParams.get(queryParam), served) : undefined);
    if (fromUrl) return { locale: fromUrl, source: 'url', vary: [] };

    if (cookie) {
        const fromCookie = match(readCookie(request.headers.get('cookie'), cookie), served);
        if (fromCookie) return { locale: fromCookie, source: 'cookie', vary: ['Cookie'] };
    }

    const vary = [...(cookie ? ['Cookie'] : []), 'Accept-Language'];
    for (const tag of preferences(request.headers.get('accept-language'))) {
        const fromHeader = match(tag, served);
        if (fromHeader) return { locale: fromHeader, source: 'header', vary };
    }
    return { locale: canonicalizeLocale(baseLocale), source: 'base', vary };
}
