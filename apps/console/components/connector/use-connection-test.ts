"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { cancelJob, getJobStatus } from "@/app/server/actions/jobs";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/** Phases a connect flow moves through while a CONNECTION_TEST runs. */
export type ConnTestPhase =
	| "idle"
	| "saving"
	| "queued"
	| "testing"
	| "success"
	| "failed";

export interface ConnTestState {
	phase: ConnTestPhase;
	error?: string;
	/** Epoch ms the poll began — drives the elapsed-time display while in flight. */
	startedAt?: number;
}

const POLL_MS = 2000;
// ~6.5 min backstop — the server-side TTL sweep (default 5 min) fails an unclaimed
// test first, so the client normally receives FAILED; this only guards a wedged poll.
const MAX_ATTEMPTS = 200;

/**
 * Drives a cloud connect flow: save the credential, then poll the queued
 * CONNECTION_TEST job. Distinguishes `queued` (no runner has claimed it yet) from
 * `testing` (a runner is verifying), caps the poll so it can never spin forever, and
 * exposes `cancel`. The identity is finalized server-side from the job result, so a
 * SUCCESS here just refreshes the page. Replaces the per-provider polling that each
 * connect component used to hand-roll.
 */
export function useConnectionTest() {
	const router = useRouter();
	const [state, setState] = useState<ConnTestState>({ phase: "idle" });
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const jobRef = useRef<string | null>(null);
	const attemptsRef = useRef(0);

	const stop = useCallback(() => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	}, []);

	useEffect(() => () => stop(), [stop]);

	/** Saves the credential (the provider-specific action) and polls the test job. */
	const run = useCallback(
		async (save: () => Promise<{ jobId: string }>) => {
			setState({ phase: "saving" });
			let jobId: string;
			try {
				({ jobId } = await save());
			} catch (e) {
				setState({
					phase: "failed",
					error: e instanceof Error ? e.message : "Failed to save connection.",
				});
				return;
			}
			jobRef.current = jobId;
			attemptsRef.current = 0;
			setState({ phase: "queued", startedAt: Date.now() });
			stop();
			pollRef.current = setInterval(async () => {
				attemptsRef.current += 1;
				if (attemptsRef.current > MAX_ATTEMPTS) {
					stop();
					setState((s) => ({
						...s,
						phase: "failed",
						error:
							"Timed out waiting for a runner. Make sure a runner is connected, then retry.",
					}));
					return;
				}
				try {
					const r = await getJobStatus(jobId);
					if (!r) return;
					if (r.status === "SUCCESS") {
						stop();
						setState((s) => ({ ...s, phase: "success" }));
						router.refresh();
					} else if (r.status === "FAILED" || r.status === "CANCELLED") {
						stop();
						setState((s) => ({
							...s,
							phase: "failed",
							error: r.error_message || "Connection test failed.",
						}));
					} else if (r.status === "QUEUED") {
						setState((s) => ({ ...s, phase: "queued" }));
					} else {
						// CLAIMED / PROCESSING — a runner is actively verifying.
						setState((s) => ({ ...s, phase: "testing" }));
					}
				} catch {
					// Transient (network blip / refresh) — keep polling, don't fail hard.
				}
			}, POLL_MS);
		},
		[router, stop],
	);

	/** Cancels the in-flight test job and returns the flow to its form. */
	const cancel = useCallback(async () => {
		stop();
		const jobId = jobRef.current;
		if (jobId) {
			try {
				await cancelJob(jobId);
			} catch {
				// ignore — the TTL sweep will fail it anyway.
			}
		}
		setState({ phase: "idle" });
		router.refresh();
	}, [router, stop]);

	/** Resets back to the form without touching any job. */
	const reset = useCallback(() => {
		stop();
		setState({ phase: "idle" });
	}, [stop]);

	return { state, run, cancel, reset };
}
