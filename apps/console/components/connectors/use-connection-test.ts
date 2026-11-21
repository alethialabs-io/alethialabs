"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useRef, useState } from "react";
import type { CloudVerifyResult } from "@/app/server/actions/identities";
import { connectorKeys } from "@/components/connectors/connectors-board";
import type { AnalyticsProps } from "@/lib/analytics/track";
import { track } from "@/lib/analytics/track";
import { type ActionResult, type FieldErrors, describeActionError } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";

/** Phases a connect flow moves through. Verification is instant + server-side (no runner, no job). */
export type ConnTestPhase = "idle" | "saving" | "success" | "failed";

/** Health status a server-side verify resolves to (mirrors the cloud_identity status enum). */
export type VerifyStatus = CloudVerifyResult["status"];

/** The instant verify outcome a connect returns (`connectCloudAccount`'s data). */
export type VerifyOutcome = CloudVerifyResult;

/** A connect form's save: one call to `connectCloudAccount` with that form's values. */
export type ConnectSave = () => Promise<ActionResult<VerifyOutcome>>;

export interface ConnTestState {
	phase: ConnTestPhase;
	error?: string;
	/** The resolved health status on success (drives the connected-vs-degraded copy). */
	status?: VerifyStatus;
	/** Provisioning permissions found missing → the DEGRADED hint. */
	missingPermissions?: string[];
}

/** What a host may take over from the hook's default rendering. */
export interface ConnectionTestOptions {
	/**
	 * A server refusal that names fields. Given, the messages go here — a form puts each under its
	 * field — and the flow returns to its form instead of showing them again in the failure callout.
	 */
	readonly onValidationError?: (fields: FieldErrors) => void;
	/** A connect that verified (connected or degraded), with the identity it was saved to. */
	readonly onVerified?: (result: VerifyOutcome) => void;
}

/** Runs one connect form's save; the save carries its own values, so the hook needs no input type. */
function runSave(save: ConnectSave): Promise<ActionResult<VerifyOutcome>> {
	return save();
}

/**
 * Drives a cloud connect flow: save the credential and verify the connection server-side in one round
 * trip, through `useActionMutation` (ADR 0005 D4) — so the submit is disabled while it runs, a second
 * submit cannot race the first, and the board and the setup guide are invalidated when it settles.
 *
 * Three outcomes, three renders, all in place next to the form:
 * - verified (connected or degraded) → `success`;
 * - saved but not verified → `failed` with the provider's reason (a SUCCESSFUL action);
 * - refused (a malformed value, no permission, a session this workspace cannot reach) → `failed`
 *   with the refusal's message. A validation refusal is not also toasted: the message is beside the
 *   field the user is looking at — under it, when the host passes `onValidationError`.
 */
export function useConnectionTest(options: ConnectionTestOptions = {}) {
	const meta = useRef<AnalyticsProps | undefined>(undefined);
	const [validation, setValidation] = useState<string | null>(null);
	const routed = options.onValidationError !== undefined;

	const mutation = useActionMutation(runSave, {
		invalidates: connectorKeys(),
		onValidationError: (fields) => {
			if (options.onValidationError) {
				options.onValidationError(fields);
				return;
			}
			const first = Object.values(fields).find((messages) => messages && messages.length > 0);
			setValidation(first?.[0] ?? "Check the values you entered.");
		},
		// A refusal (no permission, a session this workspace cannot reach) is said once, in the
		// failure callout beside the form — not also in a toast.
		onRefusal: () => undefined,
		onSuccess: (result) => {
			if (!result.verified) return;
			// Activation milestone — completes the connect_started → connected pair.
			track("connector_connected", { status: result.status, ...meta.current });
			options.onVerified?.(result);
		},
	});

	/**
	 * Saves the credential and shows the instant verify result. `meta` (e.g. `{ provider }`) is
	 * attached to the `connector_connected` activation event. A call while one is in flight is
	 * ignored — the double-submit guard.
	 */
	const run = useCallback(
		(save: ConnectSave, runMeta?: AnalyticsProps) => {
			if (mutation.isPending) return;
			meta.current = runMeta;
			setValidation(null);
			mutation.mutate(save);
		},
		[mutation],
	);

	/** Returns the flow to its form. A save already sent still lands; its result is not shown. */
	const cancel = useCallback(() => {
		setValidation(null);
		mutation.reset();
	}, [mutation]);

	return { state: connTestState(mutation, validation, routed), run, cancel, reset: cancel };
}

/** The mutation's state, as the phases the shared status UI renders. */
function connTestState(
	mutation: {
		isPending: boolean;
		data: VerifyOutcome | undefined;
		error: { error: Parameters<typeof describeActionError>[0] } | null;
	},
	validation: string | null,
	routed: boolean,
): ConnTestState {
	if (mutation.isPending) return { phase: "saving" };
	if (validation) return { phase: "failed", error: validation };
	if (mutation.error) {
		// A field refusal the host placed under its fields is not repeated in the callout.
		if (routed && mutation.error.error.kind === "validation") return { phase: "idle" };
		return { phase: "failed", error: describeActionError(mutation.error.error) };
	}
	const r = mutation.data;
	if (!r) return { phase: "idle" };
	return r.verified
		? { phase: "success", status: r.status, missingPermissions: r.missingPermissions }
		: { phase: "failed", error: r.error ?? "Connection verification failed.", status: r.status };
}
