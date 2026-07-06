// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { getWakeTransport } from "@/lib/realtime";
import { verifyRunnerToken } from "@/lib/runners/auth";

export const dynamic = "force-dynamic";

/**
 * Push-dispatch wake stream + connection-based presence. A runner holds this SSE
 * connection open; the server pushes a `wake` whenever a job becomes claimable (the
 * jobs_runner_wake trigger → pg_notify → getWakeTransport fan-out), and the connection
 * itself IS the liveness signal: runner_present refreshes the lease on connect + every
 * ~10s ping, and runner_lost fires the instant the connection drops (req.signal abort)
 * — sub-second failure detection for the fleet controller (dataroom/spec/mvp/26). Worker stays
 * HTTPS-only (no DB access).
 */
export async function GET(req: Request) {
	const { runnerId, error } = await verifyRunnerToken(req);
	if (error) return error;

	const present = () =>
		void getServiceDb()
			.execute(sql`select runner_present(${runnerId}::uuid)`)
			.catch(() => {});
	const lost = () =>
		void getServiceDb()
			.execute(sql`select runner_lost(${runnerId}::uuid)`)
			.catch(() => {});

	const encoder = new TextEncoder();
	let closed = false;
	let unsubscribe = () => {};
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const teardown = () => {
		if (closed) return;
		closed = true;
		if (heartbeat) clearInterval(heartbeat);
		unsubscribe();
		lost(); // connection gone → mark the runner lost immediately
	};

	const stream = new ReadableStream({
		start(controller) {
			const wake = () => {
				if (closed) return;
				controller.enqueue(encoder.encode("data: wake\n\n"));
			};

			wake(); // drain any backlog on connect
			present(); // mark ONLINE + start the presence lease
			unsubscribe = getWakeTransport().subscribe(wake);

			// ~10s ping doubles as the lease refresh; a 45s gap → sweep marks OFFLINE.
			heartbeat = setInterval(() => {
				if (closed) return;
				controller.enqueue(encoder.encode(":\n\n"));
				present();
			}, 10_000);

			req.signal.addEventListener("abort", () => {
				teardown();
				try {
					controller.close();
				} catch {
					// already closed
				}
			});
		},
		cancel() {
			teardown();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		},
	});
}
