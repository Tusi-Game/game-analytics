# Retention (Classic Day-N) — Tasks

**Part of**: [001-analytics-platform](../001-analytics-platform/spec.md) · **Story**: US3 (P2) · **Status**: Draft

> **This story has no task list of its own.** Retention's implementation tasks are **combined into [003-sessions/tasks.md](../003-sessions/tasks.md)**.

**Why.** Retention owns no ingest kind and no pipeline step of its own — it consumes only the `session` typed event, and its two write sequences (the `first_seen` spine seed and the set-once activeness bit) are executed **inside the session path, on retention's behalf**. This is the *spine seam*: the same worker code path that qualifies a session also seeds `USER_SPINE`, sets the active-days bit, and increments the cohort×offset counters. Splitting these into two separate task lists would fracture one atomic ordering contract (spine row → offset math → durable bit → counter). They are therefore planned and sequenced together in the sessions task list.

The write-delegation contract that pins the transition-reporting, ordering, and crash semantics identically across both paths is [bridge 02.5 — activeness-spine-contract](../001-analytics-platform/bridges/02.5-activeness-spine-contract.md) (§5 the unified negative-offset rule, §6 the `first_seen` / DD-1 ruling).

**Go here:** **[../003-sessions/tasks.md](../003-sessions/tasks.md)**

See also: [spec.md](./spec.md) (requirements) · [design.md](./design.md) (ER, Redis, worker flow).
