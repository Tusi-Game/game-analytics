# Shared golden envelope-stream fixtures (R4)

**One physical fixture set, three consumers: 002-foundation-ingest, 008-client-sdk,
009-server-sdk.** No copies. The wire ends cannot drift because they all read
these same files (plan.md R4, Constitution P5 — one wire contract).

## Files

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
