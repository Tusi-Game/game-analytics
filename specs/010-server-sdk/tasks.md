# Server SDK (Node) — Tasks

**Story spec:** [spec.md](./spec.md) · **Design:** [design.md](./design.md)
**Part of:** [001-analytics-platform](../001-analytics-platform/spec.md)

---

## Tasks live in the sibling story

This story has **no task list of its own**. The server SDK and the client SDK are built as one packaging/conformance effort (shared monorepo `packages/`, shared reference event stream, shared wire-contract tests), so their tasks are **combined into the client-SDK task file**:

➡️ **[../009-client-sdk/tasks.md](../009-client-sdk/tasks.md)**

**Why combined:** the two SDKs are a single delivery — one wire contract, one conformance suite, one release pipeline — and the server SDK's trusted money row is validated against the same [bridge 05.5 (purchase-accept contract)](../001-analytics-platform/bridges/05.5-purchase-accept-contract.md) seam that the combined SDK conformance surface replays end-to-end. Splitting the tasks would fracture that shared suite. See [009-client-sdk/tasks.md](../009-client-sdk/tasks.md) for the server-SDK work items.
