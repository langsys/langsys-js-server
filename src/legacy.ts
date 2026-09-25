/**
 * Reading the legacy-key mode's source files on a server (MIG-8: a server core reads the file
 * directly). JSON files are parsed; any other file is passed through by name so the core's resolver
 * refuses it at load, naming the file and, for a `.mo`, its `.po` (MIG-7).
 *
 * `node:fs` is reached through `process.getBuiltinModule`, not a static import, so the bundle still
 * loads on runtimes without it; there the app parses its files and passes `legacyKeys` directly.
 */
import type { LegacyKeyFile } from 'langsys-js-typescript/pure';

export function readLegacyKeyFiles(files: readonly { path: string; format?: string; namespace?: string }[]): LegacyKeyFile[] {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const fs = proc?.getBuiltinModule?.('node:fs') as { readFileSync(path: string, encoding: 'utf8'): string } | undefined;
    if (!fs) {
        throw new Error('readLegacyKeyFiles needs node:fs; on this runtime, parse the files and pass legacyKeys directly.');
    }
    return files.map(({ path, format, namespace }) => ({
        name: path,
        ...(format ? { format } : {}),
        ...(namespace ? { namespace } : {}),
        data: /\.json$/i.test(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : undefined,
    }));
}
