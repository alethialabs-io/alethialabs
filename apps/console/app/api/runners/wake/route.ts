// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { holdRequest } from "@/lib/http/hold-request";
import { getCancelTransport, getWakeTransport } from "@/lib/realtime";
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

	// The runner's disconnect, read once here. The `Request` must stay reachable while the runner is
	// connected: its signal stops following the disconnect once the `Request` is collected, and nothing
	// below reads `req` again except the `holdRequest` in teardown (see lib/http/hold-request.ts).
	const signal = req.signal;
	const encoder = new TextEncoder();
	let closed = false;
	let unsubscribe = () => {};
	let unsubscribeCancel = () => {};
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	/** End the connection's work — heartbeat, both fan-outs — and mark the runner lost. Runs once. */
	const teardown = () => {
		// Keeps `req` reachable — and so `signal` live — until the connection is torn down. Without it a
		// GC unhooks `signal` from the disconnect, and the drop no longer fires runner_lost through it.
		holdRequest(req);
		if (closed) return;
		closed = true;
		if (heartbeat) clearInterval(heartbeat);
		unsubscribe();
		unsubscribeCancel();
		lost(); // connection gone → mark the runner lost immediately
	};

	const stream = new ReadableStream({
		start(controller) {
			const send = (payload: Record<string, unknown>) => {
				if (closed) return;
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
				);
			};
			// A wake tells the runner to attempt a claim; a cancel tells it to tear down a
			// specific in-flight job. Both are typed so the runner can dispatch on `type`.
			const wake = () => send({ type: "wake" });
			const cancel = (jobId: string) => send({ type: "cancel", job_id: jobId });

			wake(); // drain any backlog on connect
			present(); // mark ONLINE + start the presence lease
			unsubscribe = getWakeTransport().subscribe(wake);
			// Cancel fan-out is keyed by runnerId, so this connection only receives cancels
			// for jobs THIS runner owns.
			unsubscribeCancel = getCancelTransport().subscribe(runnerId, cancel);

			// ~10s ping doubles as the lease refresh; a 45s gap → sweep marks OFFLINE.
			heartbeat = setInterval(() => {
				if (closed) return;
				controller.enqueue(encoder.encode(":\n\n"));
				present();
			}, 10_000);

			signal.addEventListener("abort", () => {
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
