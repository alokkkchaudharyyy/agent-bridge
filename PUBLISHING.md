# Publishing

How to publish Agent Bridge to [Open VSX](https://open-vsx.org) (used by Antigravity, VSCodium, Cursor and others).
Never paste your token into a chat, an issue, or a file in this repo.

## One-time setup

1. **Sign in to Open VSX.** Go to https://open-vsx.org and log in with GitHub (`alokkkchaudharyyy`).
2. **Create an Eclipse account.** Register at https://accounts.eclipse.org/user/register using the same email.
   In your Eclipse profile, set the **GitHub username** field to `alokkkchaudharyyy`.
3. **Sign the Publisher Agreement.** Back on open-vsx.org: avatar → **Settings** → **Log in with Eclipse**,
   then click **Show Publisher Agreement** and accept it.
4. **Create an access token.** Settings → **Access Tokens** → **Generate New Token** (description: `agent-bridge publish`).
   Copy it somewhere safe. Open VSX shows it only once.
5. **Create the namespace** (must match `publisher` in package.json). In PowerShell, from this folder:

   ```powershell
   $env:OVSX_PAT = Read-Host -MaskInput "Open VSX token"
   npx ovsx create-namespace alokkkchaudharyyy
   ```

## Publish a version

```powershell
npm test
npm run package
$env:OVSX_PAT = Read-Host -MaskInput "Open VSX token"   # skip if still set in this terminal
npx ovsx publish agent-bridge-0.2.0.vsix
Remove-Item Env:OVSX_PAT
```

Then check https://open-vsx.org/extension/alokkkchaudharyyy/agent-bridge. It can take a few minutes to appear in IDE search.

**Optional: the verified badge.** New namespaces show as unverified. To claim yours, open a "Claim namespace" issue at
https://github.com/EclipseFdn/open-vsx.org/issues.

## Releasing a new version (checklist)

1. Bump `version` in package.json and add a section to CHANGELOG.md.
2. `npm test` and `npm run package`.
3. Commit, then `git tag -a vX.Y.Z -m "vX.Y.Z"` and `git push --follow-tags`.
4. `gh release create vX.Y.Z agent-bridge-X.Y.Z.vsix --title "Agent Bridge vX.Y.Z" --notes "..."`
5. `npx ovsx publish agent-bridge-X.Y.Z.vsix` (with `OVSX_PAT` set as above).
