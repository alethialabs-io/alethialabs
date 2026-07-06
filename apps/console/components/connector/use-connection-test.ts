"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

/** Phases a connect flow moves through. Verification is instant + server-side (no runner, no job). */
export type ConnTestPhase = "idle" | "saving" | "success" | "failed";

/** Health status a server-side verify resolves to (mirrors the cloud_identity status enum). */
export type VerifyStatus = "connected" | "degraded" | "disconnected";

/** The instant verify outcome returned by a save action (structural — matches `ConnectionResult`). */
export interface VerifyOutcome {
	verified: boolean;
	status: VerifyStatus;
	error: string | null;
	missingPermissions: string[];
}

export interface ConnTestState {
	phase: ConnTestPhase;
	error?: string;
	/** The resolved health status on success (drives the connected-vs-degraded copy). */
	status?: VerifyStatus;
	/** Provisioning permissions found missing → the DEGRADED hint. */
	missingPermissions?: string[];
}

/**
 * Drives a cloud connect flow: save the credential and verify the connection server-side in one round
 * trip (auth + provisioning-capability probe). There is no runner and no job — the save action returns
 * the verification outcome directly, so the flow resolves to `success` (connected/degraded) or `failed`
 * (disconnected) instantly. Replaces the old queued-CONNECTION_TEST polling.
 */
export function useConnectionTest() {
	const router = useRouter();
	const [state, setState] = useState<ConnTestState>({ phase: "idle" });

	/** Saves the credential (the provider-specific action) and shows the instant verify result. */
	const run = useCallback(
		async (save: () => Promise<VerifyOutcome>) => {
			setState({ phase: "saving" });
			try {
				const r = await save();
				if (r.verified) {
					setState({
						phase: "success",
						status: r.status,
						missingPermissions: r.missingPermissions,
					});
					router.refresh();
				} else {
					setState({
						phase: "failed",
						error: r.error ?? "Connection verification failed.",
						status: r.status,
					});
				}
			} catch (e) {
				setState({
					phase: "failed",
					error: e instanceof Error ? e.message : "Failed to save connection.",
				});
			}
		},
		[router],
	);

	/** Returns the flow to its form (no in-flight job to cancel). */
	const cancel = useCallback(() => {
		setState({ phase: "idle" });
		router.refresh();
	}, [router]);

	/** Resets back to the form. */
	const reset = useCallback(() => setState({ phase: "idle" }), []);

	return { state, run, cancel, reset };
}
