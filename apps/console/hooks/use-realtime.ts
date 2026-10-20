// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
	type ConnectionSnapshot,
	type ConnectionState,
	type ConnectionStore,
	connectionStore,
} from "@/lib/realtime/client/connection-state";

/** How long the stream may be down before the shell says so: a reconnect is usually quicker. */
const INDICATOR_DELAY_MS = 3000;

/** What the shell shows about live updates. */
export interface RealtimeConnection {
	state: ConnectionState;
	/** True once the stream has been non-live for longer than {@link INDICATOR_DELAY_MS}. */
	noticeable: boolean;
}

/** The server render and hydration always read "connecting since 0", so they agree. */
const SERVER_SNAPSHOT: ConnectionSnapshot = { state: "connecting", since: 0 };

/**
 * The org stream's connection state for the shell's indicator (#6115, ADR 0005 §10 R7). A blip
 * shorter than three seconds is not reported; a terminal state (signed out) is reported at once.
 */
export function useRealtimeConnection(store: ConnectionStore = connectionStore): RealtimeConnection {
	const snapshot = useSyncExternalStore(store.subscribe, store.get, () => SERVER_SNAPSHOT);
	const [elapsed, setElapsed] = useState<{ since: number; done: boolean }>({ since: -1, done: false });

	useEffect(() => {
		if (snapshot.state === "live") return;
		const remaining = Math.max(0, snapshot.since + INDICATOR_DELAY_MS - Date.now());
		const timer = setTimeout(() => setElapsed({ since: snapshot.since, done: true }), remaining);
		return () => clearTimeout(timer);
	}, [snapshot.state, snapshot.since]);

	const waited = elapsed.done && elapsed.since === snapshot.since;
	const noticeable =
		snapshot.state === "signed-out" || (snapshot.state !== "live" && snapshot.state !== "removed" && waited);
	return { state: snapshot.state, noticeable };
}
