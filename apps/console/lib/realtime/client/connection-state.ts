// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connection state of this browser's change stream (#6115, ADR 0005 §10 R7). One external
// store per page, read by the shell's indicator (`hooks/use-realtime.ts`) and by the fallback poll.
// No React in here, so the stream, the leader and the poll can all be tested without rendering.

/**
 * Where the stream stands.
 *
 * - `connecting` — no stream has said hello yet in this tab's life (or no leader tab has reported).
 * - `live` — a stream is open and has said hello; hints flow.
 * - `reconnecting` — a stream that was live closed, or one attempt failed; the next one is scheduled.
 * - `degraded` — several attempts in a row failed, or the server asked us to back off (429).
 * - `signed-out` — the session is gone. Terminal: nothing reconnects until the page is reloaded.
 * - `removed` — this address is no longer ours to read (not a member, the Terms changed). Terminal:
 *   the page is refreshed so the server decides what to show instead.
 */
export type ConnectionState =
	| "connecting"
	| "live"
	| "reconnecting"
	| "degraded"
	| "signed-out"
	| "removed";

/** The two states after which nothing reconnects. */
export function isTerminal(state: ConnectionState): boolean {
	return state === "signed-out" || state === "removed";
}

/** A state and the moment it was entered (ms since the epoch, from the store's clock). */
export interface ConnectionSnapshot {
	state: ConnectionState;
	since: number;
}

/** A minimal external store over {@link ConnectionSnapshot}, shaped for `useSyncExternalStore`. */
export interface ConnectionStore {
	get(): ConnectionSnapshot;
	set(state: ConnectionState): void;
	subscribe(listener: () => void): () => void;
}

/**
 * Builds a store. Setting the state it already holds changes nothing — `since` keeps the moment the
 * state was ENTERED, which is what "non-live for longer than N seconds" is measured from.
 */
export function createConnectionStore(now: () => number = () => Date.now()): ConnectionStore {
	let snapshot: ConnectionSnapshot = { state: "connecting", since: now() };
	const listeners = new Set<() => void>();
	return {
		get: () => snapshot,
		set(state) {
			if (state === snapshot.state) return;
			snapshot = { state, since: now() };
			for (const listener of listeners) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/**
 * The page's one store. The shell mounts one runtime at a time (keyed on the tenant), and that
 * runtime writes here; the indicator reads here.
 */
export const connectionStore: ConnectionStore = createConnectionStore();
