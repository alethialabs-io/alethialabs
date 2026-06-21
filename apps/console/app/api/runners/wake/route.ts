// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getWakeTransport } from "@/lib/realtime";
import { verifyRunnerToken } from "@/lib/runners/auth";

export const dynamic = "force-dynamic";

/**
 * Push-dispatch wake stream. A runner holds this SSE connection open; the server
 * pushes a `wake` whenever a job becomes claimable (the jobs_runner_wake trigger →
 * pg_notify → getWakeTransport fan-out). The runner reacts by calling claim. An
 * immediate wake on connect drains any backlog; a 20s heartbeat keeps proxies open.
 * Worker stays HTTPS-only (no DB access) — works for the dedicated-in-VPC tier.
 */
export async function GET(req: Request) {
	const { error } = await verifyRunnerToken(req);
	if (error) return error;

	const encoder = new TextEncoder();
	let closed = false;
	let unsubscribe = () => {};
	let heartbeat: ReturnType<typeof setInterval> | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const wake = () => {
				if (closed) return;
				controller.enqueue(encoder.encode("data: wake\n\n"));
			};

			// Drain any backlog the moment the runner connects.
			wake();
			unsubscribe = getWakeTransport().subscribe(wake);

			heartbeat = setInterval(() => {
				if (!closed) controller.enqueue(encoder.encode(":\n\n"));
			}, 20_000);

			req.signal.addEventListener("abort", () => {
				closed = true;
				if (heartbeat) clearInterval(heartbeat);
				unsubscribe();
				try {
					controller.close();
				} catch {
					// already closed
				}
			});
		},
		cancel() {
			closed = true;
			if (heartbeat) clearInterval(heartbeat);
			unsubscribe();
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
