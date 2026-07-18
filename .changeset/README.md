# Changesets

This directory holds [changesets](https://github.com/changesets/changesets) — one
per behavioral change to a **published SDK package** (`packages/sdk-client`,
`packages/sdk-server`). The private NestJS platform root (`analytics-platform`) is
ignored and never versioned or published.

To add a changeset for an SDK change:

```bash
npx changeset
```

Pick the affected package(s) and a semver bump (patch / minor / major). SDK
semver is **decoupled from the wire version** (`v:1` forever): a breaking *API*
change bumps the SDK major; the wire stays v1 additive-only.

A release PR (`changeset version`) aggregates pending changesets into version
bumps + CHANGELOG entries; publishing happens on tag via the OIDC trusted-publish
workflow (`.github/workflows/publish-sdk.yml`) — there is no `NPM_TOKEN`.
