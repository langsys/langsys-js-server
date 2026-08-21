import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node18',
    platform: 'node',
    treeshake: true,
    splitting: false,
    minify: false,

    /**
     * KEEP the `node:` prefix on builtin imports. This is not cosmetic.
     *
     * tsup 8 defaults `removeNodeProtocol` to TRUE, so `import ... from 'node:async_hooks'`
     * in src/ ships as `from 'async_hooks'` in dist/. Node and Bun tolerate the bare
     * specifier; **Deno rejects it outright** ("Import \"async_hooks\" not a dependency")
     * and Cloudflare Workers require the prefix under `nodejs_compat`.
     *
     * So the default silently made this package Node-and-Bun-only — while the README and
     * the package NAME both claim otherwise. SPEC §11 resolves `-server` rather than
     * `-node` on exactly this claim, which means the default quietly falsified the name.
     *
     * Found by executing the built dist under Deno, not by reading the config. tsup's own
     * docs note this default flips in the next major; we do not wait for that.
     *
     * `tests/build-output.test.ts` asserts the prefix survives every build.
     */
    removeNodeProtocol: false,
});
