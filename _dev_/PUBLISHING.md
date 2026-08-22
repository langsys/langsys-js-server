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

## First publish only — turn the npm badges on

`README.md` carries the family-standard badge block, but the five npm- and bundlejs-derived
badges are commented out. Until the package exists on the registry, shields.io answers
`package not found` in red, which reads as a broken package rather than an unpublished one
(verified against the live shields endpoints, not assumed).

The moment `0.1.0` is on npm, delete the `<!--` / `-->` around that block and drop the
GitHub license badge that stands in for the npm one. Nothing else in the README changes.

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
