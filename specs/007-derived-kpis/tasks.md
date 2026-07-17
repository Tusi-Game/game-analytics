# Derived KPIs (DAU/ARPU/whale) — Tasks

**Part of:** [001-analytics-platform](../001-analytics-platform/spec.md) · **Spec:** [spec.md](./spec.md) · **Design:** [design.md](./design.md)

> **This story has no task list of its own.** Its implementation work is **combined into the monetization task list.**

**Why.** Derived KPIs is a **pure consumer** that owns no event kind and stores no KPI value. Its only durable footprint — the two payer-bounded structures `PAYER_SPINE_EXT` and `PAYER_PERIOD_SPEND` — is written **in-band, in the same worker step 7, atomically with monetization's step-6 `transaction_id` gate insert** (the gate row plus this story's writes commit together or not at all). That cross-ownership atomic unit is specified normatively in [bridge 05.5 — purchase-accept contract](../001-analytics-platform/bridges/05.5-purchase-accept-contract.md). Because the writes cannot be sequenced or tested independently of the purchase-accept path, the tasks are authored and tracked together with monetization rather than split across two lists.

**Tasks live here → [../006-monetization/tasks.md](../006-monetization/tasks.md)**
