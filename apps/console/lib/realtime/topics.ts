// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The real-time bus's WIRE vocabulary (#6115, ADR 0005 D3). Isomorphic on purpose — no imports, no
// "server-only" — because both halves read it: the server routes and frames hints with it, and the
// browser client (PR B) maps each topic to the query keys it invalidates. `lib/query/topics.ts` is a
// client module, so it cannot be the server's source; this is the one list both import.

/**
 * Every topic the bus can carry. A topic names a family of rows the console renders; a hint on it
 * means "something in this family changed — refetch what you show of it". Only `jobs` has a producer
 * today (the triggers in lib/db/programmables.sql); the rest are declared so the client and the
 * routing table are exhaustive over one list, and each lane activates its own (lib/realtime/routing.ts).
 */
export const TOPICS = [
	"jobs",
	"environments",
	"projects",
	"clusters",
	"runners",
	"fleet",
	"addons",
	"alerts",
	"support",
	"usage",
] as const;

/** One topic of {@link TOPICS}. */
export type Topic = (typeof TOPICS)[number];

/**
 * The bus's own liveness probe topic. A process NOTIFYs it with a nonce and waits to hear it back on
 * its LISTEN connection (lib/realtime/self-test.ts). It is consumed by the issuer and NEVER forwarded
 * to a stream, which is why it is not in {@link TOPICS}.
 */
export const SELF_TEST_TOPIC = "_selftest";

/** Narrows an arbitrary string to a {@link Topic}. */
export function isTopic(value: string): value is Topic {
	return TOPICS.some((topic) => topic === value);
}

/**
 * An invalidation hint as it travels to the browser: the topic and, when the change was to one row,
 * that row's id. NOTHING else — not the org, the owner or the project the row belongs to. The read
 * path is the replay: the client refetches through the same authorised read it already uses.
 */
export interface Hint {
	t: Topic;
	id?: string;
}

/** Why a stream was told to invalidate everything it shows. */
export type ResyncReason = "reconnect" | "backpressure" | "keys-changed";

/** Why a stream was ended by the server for good (the client must not simply reconnect). */
export type RevokedReason = "unauthorized" | "not-member" | "terms";

/** The protocol version carried in `hello`. */
export const PROTOCOL_VERSION = 1;

/**
 * Every event the server sends on `/{org}/~/events`, as the client's parser sees it.
 *
 * - `hello` opens every stream: the process's boot id and this stream's cursor. A client that saw a
 *   different boot, or a different cursor, before it reconnected missed something and resyncs.
 * - `hint` carries one {@link Hint}; its SSE `id:` is the cursor after it.
 * - `resync` means "invalidate everything you show for this org" (a LISTEN reconnect, a dropped burst).
 * - `revoked` ends the stream: the session ended, the membership went, or the Terms changed.
 */
export type ServerEvent =
	| { type: "hello"; v: typeof PROTOCOL_VERSION; boot: string; cursor: string }
	| { type: "hint"; cursor: string; hint: Hint }
	| { type: "resync"; cursor: string; reason: ResyncReason }
	| { type: "revoked"; reason: RevokedReason };
