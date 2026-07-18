# Publishing the SDK packages to npm

The two SDKs in `packages/` publish to npm **independently** of the platform:

| Package | npm name | License |
|---|---|---|
| `packages/sdk-client` | `@tusi-game/analytics-sdk` | MIT |
| `packages/sdk-server` | `@tusi-game/analytics-sdk-server` | MIT |

Publishing uses npm **trusted publishing (OIDC)** with automatic provenance
attestations — **there is no `NPM_TOKEN` anywhere**. The registry mints a
short-lived credential from the GitHub Actions workflow's OIDC identity. This is
the modern, token-free flow and requires a one-time setup on npmjs.com.

The on-the-wire `sdk.name` (`analytics-sdk` / `analytics-sdk-server`) is stable
regardless of the npm scope, so the scope choice never changes the protocol.

---

## One-time setup (maintainer, on npmjs.com)

These steps require your npm account — CI cannot do them.

1. **Create the npm org.** Create the `tusi-game` organization on npmjs.com so the
   `@tusi-game/*` scope resolves to an org you own. (If you want a different scope,
   rename the `name` field in both `packages/*/package.json` and the repo URLs, and
   update `.github/workflows/publish-sdk.yml`'s tag patterns to match.)

2. **Enable 2FA** on the npm account (required for provenance / trusted publishing).

3. **Configure a Trusted Publisher for each package.** For **both**
   `@tusi-game/analytics-sdk` and `@tusi-game/analytics-sdk-server`, on the
   package's npm settings page → *Trusted Publisher*, add a GitHub Actions
   publisher pointing at:

   | Field | Value |
   |---|---|
   | Repository owner | `Tusi-Game` |
   | Repository | `game-analytics` |
   | Workflow filename | `publish-sdk.yml` |
   | Environment | *(leave blank)* |

   > A brand-new scoped package can't be configured as a trusted publisher until it
   > exists. If the registry won't let you pre-register it, do the **very first**
   > publish once with a granular automation token (see "First publish" below),
   > then switch to trusted publishing for every release after that.

---

## Cutting a release

The repo uses [changesets](https://github.com/changesets/changesets). Day-to-day:

1. **Add a changeset** describing the change (run on a branch):
   ```bash
   npm run changeset
   ```
   This writes a markdown file under `.changeset/`. Commit it with your change.

2. **Merge to `master`.** The `release-pr.yml` workflow opens/updates a
   **"Version Packages"** PR that bumps versions and rewrites the SDK CHANGELOGs
   from the accumulated changesets. (An initial changeset for the `0.1.0` release
   already exists at `.changeset/initial-sdk-release.md`.)

3. **Merge the Version PR.** This lands the version bump on `master`.

4. **Tag to publish.** `publish-sdk.yml` triggers on the release tags. After the
   version bump is on `master`:
   ```bash
   git tag '@tusi-game/analytics-sdk@0.1.0'
   git tag '@tusi-game/analytics-sdk-server@0.1.0'
   git push --tags
   ```
   The workflow builds, tests, and `npm publish --provenance`es each package via
   OIDC. You can also run it manually from the **Actions → Publish SDK** tab
   (`workflow_dispatch`) once the trusted publisher is configured.

The publish steps emit a **warning (not a hard failure)** if a version is already
published or the trusted publisher isn't configured yet, so a premature run is a
no-op rather than a red build. Genuine auth/build failures still fail the job.

---

## First publish (bootstrap, only if pre-registration isn't possible)

If npm won't let you register a trusted publisher for a package that doesn't exist
yet, do the first publish locally with a short-lived **granular access token**
scoped to the `@tusi-game` org, then delete the token and rely on OIDC afterward:

```bash
npm ci
npm run sdk:build
npm run sdk:test

# with a granular automation token exported as NODE_AUTH_TOKEN, or `npm login`:
npm publish --workspace=packages/sdk-client  --provenance --access public
npm publish --workspace=packages/sdk-server  --provenance --access public
```

After this, configure the trusted publishers (step 3 above) and never use a token
again — all subsequent releases go through the tag-triggered OIDC workflow.

---

## Verifying a published package

```bash
npm view @tusi-game/analytics-sdk
npm view @tusi-game/analytics-sdk-server
```

Provenance shows up on the package page as a "Built and signed on GitHub Actions"
badge once published via the OIDC workflow.
