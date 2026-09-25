import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The vendored API contract double, run as a real HTTP process (spec CONF-2). Tests seed it,
 * point the SDK's `apiUrl` at `baseUrl`, and assert on the state the double ACCEPTED — it has
 * no route that returns what it received.
 */
export interface Double {
    baseUrl: string;
    seed(doc: unknown): Promise<void>;
    state(): Promise<{ projects: Record<string, { phrases: { category: string | null; phrase: string }[]; blocks: { custom_id: string | null; phrases: { phrase: string }[] }[] }> }>;
    stop(): Promise<void>;
}

const SERVER = fileURLToPath(new URL('../../contract-fixture/server.mjs', import.meta.url));

export async function startDouble(): Promise<Double> {
    const child: ChildProcess = spawn(process.execPath, [SERVER], { stdio: ['ignore', 'pipe', 'inherit'] });
    const ready = await new Promise<{ base_url: string; fixture_url: string }>((resolve, reject) => {
        let buf = '';
        child.stdout!.on('data', (d) => {
            buf += String(d);
            const line = buf.split('\n').find((l) => l.includes('"ready"'));
            if (line) resolve(JSON.parse(line));
        });
        child.once('exit', (code) => reject(new Error(`contract double exited early (${code})`)));
    });
    const call = async (path: string, body?: unknown) => {
        const res = await fetch(`${ready.fixture_url}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!res.ok) throw new Error(`double ${path} answered ${res.status}: ${await res.text()}`);
        return res.json();
    };
    return {
        baseUrl: ready.base_url,
        seed: async (doc) => {
            await call('/seed', doc);
        },
        state: () => call('/state'),
        stop: () =>
            new Promise((resolve) => {
                if (child.exitCode !== null) return resolve();
                child.once('exit', () => resolve());
                child.kill();
            }),
    };
}

/** A project `p` whose base locale is `en`, translated to `it`, with a write key `wk`. */
export function seedDoc(extra: { phrases?: unknown[]; faults?: unknown[] } = {}) {
    return {
        projects: [{ id: 'p', base_locale: 'en', target_locales: ['it'], phrases: extra.phrases ?? [] }],
        keys: [{ key: 'wk', type: 'write', project: 'p' }],
        faults: extra.faults ?? [],
    };
}
