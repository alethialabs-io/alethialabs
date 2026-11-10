// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { log } from "@/lib/observability/log";
import { registerLoop, superviseLoop } from "@/lib/observability/heartbeats";
import { type BusStats, type ChangeBus, getChangeBus } from "./bus";
import { CHANGE_CHANNEL, type ChangeTransport, getChangeTransport } from "./index";
import { SELF_TEST_TOPIC } from "./topics";

const slog = log.child({ component: "realtime-self-test" });

/** Stable supervision id (lib/observability/heartbeats.ts) — /health shows it under `loops`. */
const REALTIME_BUS_LOOP_ID = "realtime-bus";

/** How often the round trip is proved. Three misses (90 s) and /health reads `degraded`. */
const SELF_TEST_INTERVAL_MS = 30_000;

/** How long a NOTIFY may take to come back before the LISTEN is called deaf. */
const SELF_TEST_TIMEOUT_MS = 5_000;

declare global {
	var __alethiaRealtimeSelfTest: ReturnType<typeof setInterval> | undefined;
}

/** What one self-test needs; injectable so the unit test drives every branch without Postgres. */
export interface SelfTestDeps {
	bus: Pick<ChangeBus, "awaitSelfTest" | "stats">;
	transport: Pick<ChangeTransport, "whenListening" | "restart">;
	notify: (nonce: string) => Promise<void>;
	nonce: () => string;
	timeoutMs: number;
}

/** NOTIFY the bus's own channel with a nonce, through the ordinary service pool. */
async function sendSelfTestNotify(nonce: string): Promise<void> {
	const payload = JSON.stringify({ t: SELF_TEST_TOPIC, n: nonce });
	await getServiceDb().execute(sql`select pg_notify(${CHANGE_CHANNEL}, ${payload})`);
}

/**
 * One round trip: NOTIFY a nonce on `alethia_change` and wait to hear it on this process's LISTEN
 * connection. Returns the bus counters (they become `lastResult` on /health, where `streams` is the
 * leak counter: it must fall back to 0 when every tab is closed).
 *
 * WHY THIS EXISTS (ADR 0005 §10 R7). A LISTEN can be deaf with nothing reporting it: postgres-js
 * swallows a failed re-LISTEN after a dropped connection, and a transaction-mode pooler accepts the
 * LISTEN and then hands the session to someone else. Either way every tab silently stops updating.
 * Only a round trip proves it. On a miss this rebuilds the connection — whose first LISTEN then
 * broadcasts `resync` to every stream — and THROWS, so the supervised loop records the failure and
 * /health turns `degraded` if it keeps happening.
 */
export async function selfTestOnce(deps?: Partial<SelfTestDeps>): Promise<BusStats> {
	const d: SelfTestDeps = {
		bus: deps?.bus ?? getChangeBus(),
		transport: deps?.transport ?? getChangeTransport(),
		notify: deps?.notify ?? sendSelfTestNotify,
		nonce: deps?.nonce ?? randomUUID,
		timeoutMs: deps?.timeoutMs ?? SELF_TEST_TIMEOUT_MS,
	};

	const listening = await d.transport.whenListening(d.timeoutMs);
	if (listening) {
		const nonce = d.nonce();
		const heard = d.bus.awaitSelfTest(nonce, d.timeoutMs);
		// A NOTIFY that cannot be SENT is a database problem, not a deaf LISTEN: it propagates as is and
		// the connection is left alone (the next tick tells the two apart once the database is back).
		await d.notify(nonce);
		if (await heard) return d.bus.stats();
	}

	slog.error(
		"the change bus did not hear its own NOTIFY — live updates are paused and every open tab falls back to its poll. If Postgres is reached through a transaction-mode pooler, set ALETHIA_LISTEN_DATABASE_URL to a direct (or session-mode) connection. Rebuilding the LISTEN connection.",
		{ listening, timeoutMs: d.timeoutMs },
	);
	d.transport.restart();
	throw new Error(
		listening
			? `realtime bus: NOTIFY round trip did not complete within ${d.timeoutMs} ms`
			: `realtime bus: LISTEN was not established within ${d.timeoutMs} ms`,
	);
}

/**
 * Start the change bus and its supervised self-test (idempotent across HMR and module instances).
 * Called at boot from instrumentation.ts, and again — as a no-op or a lazy start — by the events
 * route before its first subscribe.
 */
export function startRealtimeBus(): void {
	if (globalThis.__alethiaRealtimeSelfTest) return;
	if (!process.env.ALETHIA_DATABASE_URL) return; // no DB configured yet
	registerLoop(REALTIME_BUS_LOOP_ID, { intervalMs: SELF_TEST_INTERVAL_MS });
	getChangeBus().start();
	globalThis.__alethiaRealtimeSelfTest = setInterval(() => {
		void superviseLoop(REALTIME_BUS_LOOP_ID, () => selfTestOnce());
	}, SELF_TEST_INTERVAL_MS);
	// The boot-time self-test: a deaf LISTEN is named in the first seconds, not 30 s in.
	void superviseLoop(REALTIME_BUS_LOOP_ID, () => selfTestOnce());
}
