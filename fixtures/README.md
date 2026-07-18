# Shared golden envelope-stream fixtures (R4)

**One physical fixture set, three consumers: 002-foundation-ingest,
009-client-sdk, 010-server-sdk.** No copies. The wire ends cannot drift because
they all read these same files (plan.md R4, Constitution P5 — one wire contract).

## Files

- `golden-client-emissions.json` — the canonical CLIENT-SDK emissions (generic,
  economy, zero-money purchase companion, identify alias edge, terminal session
  incl. `reconciled`). The client SDK's conformance tests assert its output
  matches these; ingest tests can replay them. Ids (`evt-*`, `s-*`, `pa-*`) are
  STATIC PLACEHOLDERS — the SDK mints ULIDs at runtime, so conformance asserts
  **shape + field-names + the fixed non-id fields**, never the exact minted ids.
  Load via `goldenClientEmissions()`.
- `golden-verified-purchase.json` — the canonical SERVER-SDK verified-purchase
  emissions ([006-monetization §3] required-field set, `source=server`, no
  normalized amount, no extra top-level field). Each entry carries
  `forbidden_prop_keys` / `forbidden_top_level_keys` the conformance tests assert
  are ABSENT. Load via `goldenVerifiedPurchases()`.
- `golden-envelope-stream.json` — the canonical batch stream for game `game-42`.
  A single `BatchRequest`-shaped object (`{ v, sdk, events }`) whose `events`
  array is deliberately heterogeneous: valid generic events, duplicates,
  reserved-name overrides, malformed typed events, and malformed drops. Each
  event carries a `_fixture` annotation (a documentation-only field, stripped by
  the loader) describing the verdict it is expected to produce so a reader can
  see the intent inline.
- `index.ts` — the typed loader. `loadGoldenStream()` returns the parsed batch
  with `_fixture` annotations removed from every envelope, plus
  `goldenExpectations()` which returns the per-event expected verdict for
  conformance assertions. This is the ONLY sanctioned way to read the fixtures
  in code — do not `JSON.parse` the file directly, so annotation-stripping stays
  centralized.

## Trust-boundary note (DARK-SPOT #9)

Every envelope in the stream carries `game_id` (as the SDK would emit it). The
ingest front door IGNORES the body `game_id` and stamps the game resolved from
the credential. The isolation fixture (`game_id: "game-99"` on some events)
exists specifically to prove that body-supplied game id is discarded.
</invoke>
