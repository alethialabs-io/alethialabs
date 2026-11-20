"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The out-of-band operations the inspector stages (#6834): what each one is called, what it
// carries, and how it is run when the changeset is applied.
//
// An add-on's install form and a chart workload's overlay used to write to the server from their
// own Save button, beside node forms that staged into a draft a different bar saved. They now add
// a `StagedOperation` to the document instead. Nothing here decides WHEN an operation runs: the
// changes bar does, by calling `useApplyStagedOperations`. Until that bar claims the operations
// (`useClaimStagedOperations`), the rail draws its own strip for them, so a staged operation is
// never something no control on the page can apply.
//
// `StagedOperation.input` is `unknown` in the store on purpose: the store keeps it in the draft
// and never reads it. It is read here, through a schema, at the moment it is run — a draft restored
// from sessionStorage is data from outside the program.
//
// Secrets are the one thing an operation does not carry. The draft is written to sessionStorage,
// so a secret typed into an add-on field is held in memory beside the operation (`rememberSecrets`)
// and joined to it when it runs. After a reload the operation is still staged and its secrets are
// gone; running it is refused with a sentence that says to type them again.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import { disableAddonAction, enableAddonAction } from "@/app/server/actions/addons";
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
	serviceBindingSchema,
	serviceEnvSchema,
} from "@/lib/validations/project-form.schema";

/** The id an add-on's staged operation is filed under. One per add-on, so a later edit replaces it. */
export function addonOperationId(addonId: string): string {
	return `addon:${addonId}`;
}

/** The id a chart workload's staged overlay is filed under. */
export function workloadOperationId(workloadId: string): string {
	return `chart-workload:${workloadId}`;
}

const addonTarget = z.object({
	projectId: z.string(),
	environmentId: z.string().nullable(),
	addonId: z.string(),
});

/** What a staged add-on install or update carries. */
export const addonEnableInputSchema = addonTarget.extend({
	mode: z.enum(["managed", "gitops"]),
	/** The add-on's knobs. A secret knob is absent here: see `secretPaths`. */
	values: z.record(z.string(), z.unknown()),
	valuesYaml: z.string(),
	/** The chart-version pin; null means the catalog's default. */
	version: z.string().nullable(),
	/** Dotted paths of the secret knobs that were typed. Their values are held in memory only. */
	secretPaths: z.array(z.string()),
});
export type AddonEnableInput = z.infer<typeof addonEnableInputSchema>;

/** What a staged add-on removal carries. */
export const addonRemoveInputSchema = addonTarget;
export type AddonRemoveInput = z.infer<typeof addonRemoveInputSchema>;

/** What a staged chart-workload overlay carries: only the parts that differ from what is saved. */
export const workloadOverlayInputSchema = z.object({
	projectId: z.string(),
	workloadId: z.string(),
	bindings: z.array(serviceBindingSchema).optional(),
	config: z
		.object({
			replicas: z.number().int().min(0).optional(),
			env: z.array(serviceEnvSchema).optional(),
		})
		.optional(),
	valuePaths: z.record(z.string(), z.string()).optional(),
});
export type WorkloadOverlayInput = z.infer<typeof workloadOverlayInputSchema>;

const secretVault = new Map<string, Record<string, string>>();

/** Hold the secrets typed for an operation, in memory, for as long as the tab lives. */
export function rememberSecrets(operationId: string, secrets: Record<string, string>): void {
	if (Object.keys(secrets).length === 0) secretVault.delete(operationId);
	else secretVault.set(operationId, secrets);
}

/** The secrets held for an operation, by dotted path. Empty when none were typed or after a reload. */
export function recallSecrets(operationId: string): Record<string, string> {
	return secretVault.get(operationId) ?? {};
}

/** Drop the secrets held for an operation: it ran, or it was discarded. */
export function forgetSecrets(operationId: string): void {
	secretVault.delete(operationId);
}

/** True for a plain object: something a dotted path can be written into. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `values` with `value` written at the dotted `path`, without changing `values`. */
export function withValueAt(
	values: Record<string, unknown>,
	path: string,
	value: unknown,
): Record<string, unknown> {
	const [head, ...rest] = path.split(".");
	if (head === undefined || head === "") return values;
	if (rest.length === 0) return { ...values, [head]: value };
	const child = values[head];
	return { ...values, [head]: withValueAt(isRecord(child) ? child : {}, rest.join("."), value) };
}

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
	if (operation.target === "addon" && operation.verb === "remove") {
		const input = addonRemoveInputSchema.safeParse(operation.input);
		if (!input.success) {
			return refuse(`${operation.summary}: ${UNREADABLE}`);
		}
		const result = await disableAddonAction(input.data);
		return result.ok ? ok({ targetId: operation.targetId }) : result;
	}
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
 * the operations that did not run still staged. This is the ONE way a staged operation is run: the
 * changes bar calls it when a changeset is applied, and the rail's own strip calls it until then.
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

let claims = 0;
const claimListeners = new Set<() => void>();

/** Tell the listeners that the number of claims changed. */
function notifyClaims(): void {
	for (const listener of claimListeners) listener();
}

/**
 * Declare that the caller applies staged operations: the changes bar, once it lists and runs them.
 * While any claim is held the rail stops drawing its own strip for them. Returns the release.
 */
export function claimStagedOperations(): () => void {
	claims++;
	notifyClaims();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		claims--;
		notifyClaims();
	};
}

/** Hold a claim on staged operations for as long as the calling component is mounted. */
export function useClaimStagedOperations(): void {
	useEffect(() => claimStagedOperations(), []);
}

/** True while some mounted surface has claimed the staged operations. */
export function useStagedOperationsClaimed(): boolean {
	return useSyncExternalStore(
		(listener) => {
			claimListeners.add(listener);
			return () => {
				claimListeners.delete(listener);
			};
		},
		() => claims > 0,
		() => false,
	);
}
