# Publishing Guide for `langsys-js-server`

This project includes an automated publishing script (`_dev_/publish.sh`) to streamline the release process.

## Prerequisites

Before using the publishing script:

1. **GitHub CLI (`gh`)** installed — see [`GITHUB_CLI_SETUP.md`](./GITHUB_CLI_SETUP.md).
2. **npm authentication** configured (`npm login`).
3. **Git** configured with push access to `git@github.com:langsys/langsys-js-server.git`.
4. You're on the `main` branch with unpushed commits ready to release.
5. `npm run build` succeeds locally.

## Running

```bash
npm run release
# or
./_dev_/publish.sh
```

## Before the next release: trusted publishing is NOT configured yet

`0.1.0` was published **by hand**, not by this script's workflow, and the reason matters
for `0.1.1`.

`publish.yml` publishes with OIDC trusted publishing and no token. That requires a trusted
publisher registered on npmjs.com **for the package**, and a package that does not exist
yet cannot have one — a chicken-and-egg every first publish in this family hits. Two runs
failed before the manual bootstrap, and both logs are worth knowing:

1. `npm error code EUSAGE — Can't generate provenance for new or private package, you must
   set access to public.` `--provenance` requires access to be stated explicitly the first
   time a name appears. Fixed permanently by `publishConfig.access` in `package.json`.
   (`--access public` on the command line is a no-op here for a different reason: the name
   is unscoped, and unscoped packages are always public. Only scoped names default to
   restricted.)
2. `npm error 404 Not Found - PUT .../langsys-js-server`. Not a missing package — npm
   returns 404 rather than 403 for an unauthorized write. The run's environment showed
   `NODE_AUTH_TOKEN: XXXXX-XXXXX-XXXXX-XXXXX`, the placeholder `actions/setup-node` writes
   when `registry-url` is set and no token is supplied, and nothing in the log showed an
   OIDC exchange at all.

**The package now exists, so the missing half can be supplied.** Before tagging `0.1.1`,
either register a trusted publisher on npmjs.com for `langsys-js-server` pointing at repo
`langsys/langsys-js-server`, workflow `publish.yml`, environment `npm-publish` — or add an
`NPM_TOKEN` secret and wire `NODE_AUTH_TOKEN` into the publish step. **Until one of those
is done, `publish.sh` will create a tag and a GitHub release and then fail at the registry**,
exactly as it did here. It fails safely — nothing is published — but the tag and release
have to be deleted and recreated.

## What the script does

1. **Verify prerequisites** — in this order; the ordering is load-bearing, see the comments in `publish.sh`
    - `gh` installed and authenticated
    - Current branch is `main`
    - **Fetches from origin first**, so every check below reads current remote state rather than a stale remote-tracking ref
    - Aborts if `origin/main` carries commits you do not have — publishing would force-push over them
    - Aborts unless at least one unpushed commit exists. Already pushed? Add a new commit (`git commit --allow-empty -m "chore: prepare release"`) and let the script amend that. Do **not** `git commit --amend --no-edit` to re-stamp the pushed commit: that rewrites already-published history, and since 0.6.5 the divergence guard correctly refuses it
2. **Version management**
    - Reads current version from `package.json`
    - Suggests the next patch version
    - Validates the entered version against `x.y.z[-tag]` semver
    - Confirms the version doesn't already exist as a tag
3. **Build + version bump**
    - Updates `version` in `package.json`
    - Runs `npm install` to refresh `package-lock.json`
    - Runs `npm run build` (tsup → `dist/`)
    - Runs `_dev_/tarball-acceptance.sh` — packs the tarball, installs it into an empty project resolving only its declared dependencies, and runs an acceptance smoke through both entry points. This runs **after** the version bump on purpose: the bump edits the very file whose `files`, `exports` and `dependencies` blocks decide whether a consumer's first `import` throws. Aborts before anything is pushed or tagged.
4. **Git operations**
    - Stages `package.json` + `package-lock.json`
    - Amends the latest commit with the version bump appended to its message
    - Force-pushes with `--force-with-lease` to origin
    - Creates and pushes the `vx.y.z` tag
5. **Release**
    - Creates a GitHub release with auto-generated notes from commit history since the previous tag
    - Publishes to npm
6. **Rollback** (on any failure)
    - Restores the original `package.json` version
    - Resets the local commit if amended
    - Deletes the local/remote tag if created
    - Force-pushes the rollback if the amended commit was pushed

## Version format

Standard semver: `x.y.z` or `x.y.z-tag` (e.g. `1.2.3`, `2.0.0-beta.1`).

## Manual publishing

If you'd rather not use the script:

```bash
# 1. Clean state on main
git checkout main
git status                                       # nothing uncommitted

# 2. Bump the version in package.json manually

# 3. Refresh lockfile and verify build
npm install
npm run build

# 4. Commit
git add package.json package-lock.json
git commit -m "chore: bump version to x.y.z"

# 5. Push and tag
git push origin main
git tag -a vx.y.z -m "Release vx.y.z"
git push origin vx.y.z

# 6. GitHub release
gh release create vx.y.z --title "vx.y.z" --notes "Release notes here"

# 7. Publish to npm
npm publish
```

## Troubleshooting

### `gh: command not found`
Install via [`GITHUB_CLI_SETUP.md`](./GITHUB_CLI_SETUP.md).

### `npm publish` fails with 403
Run `npm login` to refresh your token. For org-scoped names, ensure you have publish rights on the org.

### `Permission denied` on `publish.sh`
```bash
chmod +x _dev_/publish.sh
```

### Rollback didn't restore everything
Manual recovery:
```bash
# Restore previous commit
git reset --hard HEAD~1

# Delete local tag
git tag -d vx.y.z

# Delete remote tag (if pushed)
git push origin :refs/tags/vx.y.z

# If you also need to roll back the amended commit
git push --force-with-lease origin main
```

## Security notes

- Never commit credentials.
- The script uses `gh` and `npm` tokens from your local keychain — they don't touch the repo.
- For CI publishing later, use GitHub Actions secrets and a granular npm automation token.
