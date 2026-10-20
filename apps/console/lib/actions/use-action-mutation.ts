// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import {
	type QueryKey,
	type UseMutationResult,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
	ActionFailure,
	type ActionError,
	type ActionResult,
	type FieldErrors,
	describeActionError,
} from "@/lib/actions/result";

/** An optimistic patch: apply `update` to the cached value at `key` before the server answers. */
export interface OptimisticPatch<V> {
	key: QueryKey;
	update: (current: unknown, variables: V) => unknown;
}

/** Options for {@link useActionMutation}. */
export interface ActionMutationOptions<T, V> {
	/** Every query key that shows data this action changes; invalidated when the action settles. */
	invalidates: QueryKey[] | ((data: T | undefined, variables: V) => QueryKey[]);
	/** Optimistic patches, rolled back from a snapshot if the action fails. */
	optimistic?: OptimisticPatch<V>[];
	/** Validation errors go to the form, not a toast — pass react-hook-form's `setError` adapter. */
	onValidationError?: (fields: FieldErrors) => void;
	/** Entitlement refusals open the upgrade surface the caller owns (e.g. `useUpgradeSheet`). */
	onEntitlement?: (feature: string, message: string) => void;
	/** A success toast, only when the outcome is not otherwise visible on screen. */
	successMessage?: string | ((data: T) => string);
	/** Runs after a successful action and its invalidation have been issued. */
	onSuccess?: (data: T, variables: V) => void;
}

/** The snapshot taken before optimistic patches, restored on failure. */
interface Snapshot {
	entries: Array<{ key: QueryKey; value: unknown }>;
}

/**
 * The client half of the mutation contract (ADR 0005 §D4). Wraps a server action that returns
 * `ActionResult<T>` in a TanStack mutation that:
 *
 * - is pending while in flight (`isPending`) — bind it to the trigger's `disabled`, which is the
 *   double-submit guard F015 found missing;
 * - applies optional optimistic patches and restores the snapshot on failure;
 * - invalidates every declared key when it settles, so no screen keeps stale data (F036, F040);
 * - routes failures by kind: validation → the form, entitlement → the caller's upgrade surface,
 *   unauthenticated → sign-in, everything else → one toast with a human message (never raw
 *   validator text, F013).
 */
export function useActionMutation<T, V>(
	action: (variables: V) => Promise<ActionResult<T>>,
	options: ActionMutationOptions<T, V>,
): UseMutationResult<T, ActionFailure, V, Snapshot> {
	const queryClient = useQueryClient();
	const router = useRouter();

	return useMutation<T, ActionFailure, V, Snapshot>({
		mutationFn: async (variables) => {
			const result = await action(variables);
			if (!result.ok) throw new ActionFailure(result.error);
			return result.data;
		},
		onMutate: async (variables) => {
			const entries: Snapshot["entries"] = [];
			for (const patch of options.optimistic ?? []) {
				await queryClient.cancelQueries({ queryKey: patch.key });
				entries.push({ key: patch.key, value: queryClient.getQueryData(patch.key) });
				queryClient.setQueryData(patch.key, (current: unknown) =>
					patch.update(current, variables),
				);
			}
			return { entries };
		},
		onError: (failure, _variables, snapshot) => {
			// Newest first: two patches on one key restore the value from BEFORE the first one.
			for (const entry of [...(snapshot?.entries ?? [])].reverse()) {
				queryClient.setQueryData(entry.key, entry.value);
			}
			handleFailure(failure.error, options, () =>
				router.push(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`),
			);
		},
		onSuccess: (data, variables) => {
			const message =
				typeof options.successMessage === "function"
					? options.successMessage(data)
					: options.successMessage;
			if (message) toast.success(message);
			options.onSuccess?.(data, variables);
		},
		onSettled: (data, _error, variables) => {
			const keys =
				typeof options.invalidates === "function"
					? options.invalidates(data, variables)
					: options.invalidates;
			for (const queryKey of keys) {
				void queryClient.invalidateQueries({ queryKey });
			}
		},
	});
}

/** The toast policy: one treatment per error kind. */
function handleFailure<T, V>(
	error: ActionError,
	options: ActionMutationOptions<T, V>,
	toSignIn: () => void,
): void {
	switch (error.kind) {
		case "validation":
			if (options.onValidationError) {
				options.onValidationError(error.fields);
				return;
			}
			toast.error(error.message);
			return;
		case "entitlement":
			if (options.onEntitlement) {
				options.onEntitlement(error.feature, error.message);
				return;
			}
			toast.error(error.message);
			return;
		case "unauthenticated":
			toSignIn();
			return;
		default:
			toast.error(describeActionError(error));
	}
}
