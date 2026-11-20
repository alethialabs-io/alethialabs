"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Running the operations the inspector staged (#6834).
//
// Each one goes through the server action it always went through — `enableAddonAction`,
// `saveChartWorkloadOverlayAction` — so every authorization, gate and refusal is the one that
// already exists. What an operation carries is read through its schema
// (`staged-operations.ts`) at the moment it runs: a draft restored from sessionStorage is data
// from outside the program.

import { useCallback } from "react";
import { enableAddonAction } from "@/app/server/actions/addons";
import { saveChartWorkloadOverlayAction } from "@/app/server/actions/byo-charts";
import { ok, type ActionResult } from "@/lib/actions/result";
import {
	useActionMutation,
	type ActionMutation,
	type RefusalError,
} from "@/lib/actions/use-action-mutation";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import type { StagedOperation } from "@/lib/canvas/store/types";
import { orpc } from "@/lib/rpc/client";
import {
	addonEnableInputSchema,
	forgetSecrets,
	recallSecrets,
	withValueAt,
	workloadOverlayInputSchema,
} from "./staged-operations";

const UNREADABLE = "this staged change cannot be read. Discard it and make it again.";

/** A refusal made here, before any server action is called. */
function refuse(message: string): ActionResult<never> {
	return { ok: false, error: { kind: "conflict", message } };
}

/**
 * Run one staged operation through the server action it was always run through. Answers that
 * action's result; an operation this file cannot read is refused rather than guessed at.
 */
export async function runStagedOperation(
	operation: StagedOperation,
): Promise<ActionResult<{ targetId: string }>> {
	// Removing an add-on is a confirmed, immediate action on the add-on subject; it is never staged.
	if (operation.verb === "remove") return refuse(`${operation.summary}: ${UNREADABLE}`);
	if (operation.target === "addon") {
		const input = addonEnableInputSchema.safeParse(operation.input);
		if (!input.success) {
			return refuse(`${operation.summary}: ${UNREADABLE}`);
		}
		const { secretPaths, ...rest } = input.data;
		const secrets = recallSecrets(operation.id);
		const missing = secretPaths.filter((path) => secrets[path] === undefined);
		if (missing.length > 0) {
			return refuse(
				`${operation.summary}: type its secret values again. Secrets are not kept when the page reloads.`,
			);
		}
		let values = rest.values;
		for (const path of secretPaths) values = withValueAt(values, path, secrets[path]);
		const result = await enableAddonAction({ ...rest, values });
		return result.ok ? ok({ targetId: operation.targetId }) : result;
	}
	const input = workloadOverlayInputSchema.safeParse(operation.input);
	if (!input.success) {
		return refuse(`${operation.summary}: ${UNREADABLE}`);
	}
	const result = await saveChartWorkloadOverlayAction(input.data);
	return result.ok ? ok({ targetId: operation.targetId }) : result;
}

/** Where the outcome of applying staged operations is said. */
export interface ApplyStagedOperationsOptions {
	/** A refusal to show inline, beside the control that was pressed. Without it, a toast says it. */
	onRefusal?: (error: RefusalError) => void;
	/** Runs after every operation in the call was applied. */
	onSuccess?: (data: { applied: number }) => void;
}

/**
 * Apply staged operations, in order, on the mutation contract: pending while in flight, a refusal
 * routed to the caller, and the add-on and chart reads invalidated when it settles.
 *
 * Each operation is taken off the changeset as it succeeds, so a refusal part-way leaves exactly
 * the operations that did not run still staged. This is the ONE way a staged operation is run. The
 * rail's own strip calls it today; the changes bar is to call it when it applies a changeset, and
 * the strip stops drawing once the bar has claimed the operations.
 */
export function useApplyStagedOperations(
	options: ApplyStagedOperationsOptions = {},
): ActionMutation<{ applied: number }, StagedOperation[]> {
	const board = useBoard();
	const apply = useCallback(
		async (operations: StagedOperation[]): Promise<ActionResult<{ applied: number }>> => {
			let applied = 0;
			for (const operation of operations) {
				const result = await runStagedOperation(operation);
				if (!result.ok) return result;
				board.document.getState().unstageOperation(operation.id);
				forgetSecrets(operation.id);
				applied++;
			}
			return ok({ applied });
		},
		[board],
	);
	return useActionMutation(apply, {
		invalidates: [
			orpc.canvas.addons.key(),
			orpc.canvas.byoCharts.key(),
			orpc.canvas.chartWorkloads.key(),
			orpc.canvas.environmentStatus.key(),
		],
		onRefusal: options.onRefusal,
		onSuccess: options.onSuccess,
		successMessage: (data) =>
			data.applied === 1 ? "1 staged change applied." : `${data.applied} staged changes applied.`,
	});
}
