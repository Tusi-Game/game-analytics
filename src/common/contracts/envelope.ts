/**
 * Canonical event envelope (Foundation §1.1).
 *
 * This is the single source of truth for the event shape every story imports.
 * No story may redefine this type — extend `props` instead.
 */

/**
 * Open string union of event kinds. Known kinds get autocomplete; unknown
 * strings are still assignable (`string & {}` keeps the literals in the union
 * without collapsing it to `string`).
 */
// `string & {}` is the canonical "open enum" idiom (design §2.1): it keeps the
// known literals for autocomplete while still accepting arbitrary strings,
// without collapsing the union to plain `string`. ban-types flags the `{}` but
// that is exactly the intent here.
// eslint-disable-next-line @typescript-eslint/ban-types
export type EventKind = 'generic' | 'economy' | 'purchase' | 'session' | (string & {});

export interface EventEnvelope {
  /** Server-derived from the SDK key. Never trusted from the request body. */
  game_id: string;
  user_id?: string;
  anon_id?: string;
  session_id?: string;
  event_id: string;
  name: string;
  kind: EventKind;
  /** Unix epoch milliseconds — when the event occurred on the client. */
  client_event_time: number;
  /** Unix epoch milliseconds — when the client flushed the batch. */
  client_sent_time: number;
  /** Unix epoch milliseconds — stamped by the front door on receipt. */
  server_received_time: number;
  props: Record<string, unknown>;
}
