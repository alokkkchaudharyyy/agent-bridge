# Publishing

Releases are automatic. Pushing a `v*` tag runs [`.github/workflows/release.yml`](../.github/workflows/release.yml), which:

1. checks the tag matches `version` in package.json,
2. runs the tests,
3. builds `agent-bridge-X.Y.Z.vsix`,
4. creates the GitHub release (notes taken from CHANGELOG.md),
5. publishes to [Open VSX](https://open-vsx.org/extension/alokkkchaudharyyy/agent-bridge) with **trusted publishing**: GitHub proves which repo and workflow is asking, so no token is stored anywhere.

Antigravity, VSCodium and Cursor users who installed from the Extensions panel then get the update automatically.

## Releasing a new version

1. Bump `version` in package.json and add a `## [X.Y.Z] - YYYY-MM-DD` section to CHANGELOG.md.
2. `npm test`, then commit.
3. Tag and push:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main vX.Y.Z
   ```

4. Watch it in the repo's **Actions** tab. To re-run for an existing tag: Actions → Release → **Run workflow** → enter the tag.

## One-time setup (already done once per extension)

On open-vsx.org → avatar → **Settings** → **Trusted Publishers** → add one for namespace `alokkkchaudharyyy`, extension `agent-bridge`:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Owner | `alokkkchaudharyyy` |
| Repository | `agent-bridge` |
| Workflow | `release.yml` |
| Environment | (leave empty) |

Requirements: you own the namespace, the Eclipse Publisher Agreement is signed, and the extension already has one version on Open VSX (the first upload was done by hand through the website's **Publish** button).

Note: anyone who can push tags or edit `release.yml` in this repo can publish the extension. Keep write access to the repo limited.

## Manual fallback

If the workflow can't publish, download the `.vsix` from the GitHub release and upload it on open-vsx.org with the **Publish** button.
