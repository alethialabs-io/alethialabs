// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import {
	type QueryKey,
	type UseMutationResult,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { ROOT_SERVER_ERROR, applyFieldErrors } from "@/lib/actions/form-errors";
import {
	ActionFailure,
	type ActionError,
	type ActionResult,
	type FieldErrors,
	describeActionError,
	toActionFailure,
} from "@/lib/actions/result";
import { endSession, isSessionEnded } from "@/lib/stores/use-session-state";

/** An optimistic patch: apply `update` to the cached value at `key` before the server answers. */
export interface OptimisticPatch<V> {
	key: QueryKey;
	update: (current: unknown, variables: V) => unknown;
}

/** Options for {@link useActionMutation}. */
export interface ActionMutationOptions<T, V, F extends FieldValues = FieldValues> {
	/** Every query key that shows data this action changes; invalidated when the action settles. */
	invalidates: QueryKey[] | ((data: T | undefined, variables: V) => QueryKey[]);
	/** Optimistic patches, rolled back from a snapshot if the action fails. */
	optimistic?: OptimisticPatch<V>[];
	/**
	 * The form this mutation submits. A `validation` result is written to it: each message under
	 * its field when the field is in `fields`, the rest in the root error that
	 * `<FormRootError form={form} />` renders. No toast is shown. Takes precedence over
	 * `onValidationError`.
	 */
	form?: { instance: UseFormReturn<F>; fields: readonly Path<F>[] };
	/**
	 * The older way to receive validation errors, kept until every caller passes `form`. Used only
	 * when `form` is not given.
	 */
	onValidationError?: (fields: FieldErrors) => void;
	/** Entitlement refusals open the upgrade surface the caller owns (e.g. `useUpgradeSheet`). */
	onEntitlement?: (feature: string, message: string) => void;
	/**
	 * A domain refusal (`conflict`, `not-found`, `forbidden`) the caller renders IN PLACE — a dialog's
	 * inline alert beside the button that was pressed, where the person can change their request and
	 * try again. When given, the refusal is handed here and NOT toasted, so one sentence is not shown
	 * twice. Omit it and the refusal is toasted like any other failure.
	 */
	onRefusal?: (error: RefusalError) => void;
	/** A success toast, only when the outcome is not otherwise visible on screen. */
	successMessage?: string | ((data: T) => string);
	/** Called with `false` on success: pass a dialog's or sheet's `onOpenChange`. */
	closes?: (open: false) => void;
	/** Runs after a successful action and its invalidation have been issued. */
	onSuccess?: (data: T, variables: V) => void;
}

/** The refusals {@link ActionMutationOptions.onRefusal} can take over from the toast. */
export type RefusalError = Extract<ActionError, { kind: "conflict" | "not-found" | "forbidden" }>;

/** The snapshot taken before optimistic patches, restored on failure. */
export interface Snapshot {
	entries: Array<{ key: QueryKey; value: unknown }>;
}

/** What {@link useActionMutation} returns: TanStack's mutation result plus `submit`. */
export type ActionMutation<T, V> = UseMutationResult<T, ActionFailure, V, Snapshot> & {
	/** `mutate` that is a no-op while a call is in flight — the double-submit guard. */
	submit: (variables: V) => void;
};

/** True when the browser reports that it has no network connection. */
function isBrowserOffline(): boolean {
	return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * The client half of the mutation contract (ADR 0005 §D4). Wraps a server action that returns
 * `ActionResult<T>` in a TanStack mutation that:
 *
 * - is pending while in flight (`isPending`) — bind it to the trigger's `disabled`, which is the
 *   double-submit guard F015 found missing; `submit` is `mutate` that also ignores a second call
 *   made before the first has settled;
 * - applies optional optimistic patches and restores the snapshot on failure;
 * - invalidates every declared key when it settles, so no screen keeps stale data (F036, F040);
 * - routes failures by kind: validation → the form, entitlement → the caller's upgrade surface,
 *   unauthenticated → the session-ended dialog (`endSession`, not a redirect: the page and what
 *   was typed into it stay where they are; once the session has ended no further action is
 *   called, and each attempt brings that dialog back), a refusal → the caller's inline alert when it renders one
 *   (`onRefusal`), everything else → one toast with a human message (never raw validator text,
 *   F013);
 * - offers **Retry** on that toast when trying again is safe and could help (#7741): an
 *   `unexpected` server failure, and a `network` failure where nothing was sent. Retry re-invokes
 *   this mutation with the same variables, through the same double-submit guard as `submit`. A
 *   refusal, a validation or entitlement message, and a `network` failure whose request DID leave
 *   the browser get no Retry: the first three would only be refused again, and the last may
 *   already have applied, so its sentence asks the person to check before trying again.
 * - treats a call that got no server answer as a failure of kind `network`. When the browser is
 *   offline the action is not called at all. When the call itself rejects, the optimistic patch
 *   is rolled back, the person is told the change could not be confirmed, and the declared keys
 *   are still invalidated, so the screen shows what the server holds.
 *
 * `networkMode` is `"always"` so that TanStack runs the mutation while offline instead of
 * holding it until the connection returns: a held mutation would send the request later, after
 * the person had moved on.
 *
 * THE STANDARD FAILURE PATH (polish-wave spec §4). Callers do not write `toast.error`: pass `form`
 * and field errors land under their fields (`form-errors.ts`); everything else is the one toast
 * above. A caller that still toasts from a per-call `mutate(variables, { onError })` keeps working —
 * TanStack runs that callback after this hook's own — but it now shows a second toast for the same
 * failure, so the hand-written one should be deleted rather than copied to a new caller.
 */
export function useActionMutation<T, V, F extends FieldValues = FieldValues>(
	action: (variables: V) => Promise<ActionResult<T>>,
	options: ActionMutationOptions<T, V, F>,
): ActionMutation<T, V> {
	const queryClient = useQueryClient();
	/** Set synchronously by `submit`, because `isPending` only changes on the next render. */
	const inFlight = useRef(false);
	/**
	 * The current `submit`, read by a failure toast's Retry. A ref because the toast outlives the
	 * render that raised it, and Retry must run the guard as it stands when it is pressed.
	 */
	const submitRef = useRef<(variables: V) => void>(() => {});

	const mutation = useMutation<T, ActionFailure, V, Snapshot>({
		networkMode: "always",
		mutationFn: async (variables) => {
			// A session that has already ended: the action is not called. The failure below reaches
			// `endSession()`, which brings the session-ended dialog back if it was set aside.
			if (isSessionEnded()) throw new ActionFailure({ kind: "unauthenticated" });
			if (isBrowserOffline()) throw new ActionFailure({ kind: "network", sent: false });
			try {
				const result = await action(variables);
				if (!result.ok) throw new ActionFailure(result.error);
				return result.data;
			} catch (thrown) {
				throw toActionFailure(thrown, true);
			}
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
		onError: (failure, variables, snapshot) => {
			inFlight.current = false;
			// Newest first: two patches on one key restore the value from BEFORE the first one.
			for (const entry of [...(snapshot?.entries ?? [])].reverse()) {
				queryClient.setQueryData(entry.key, entry.value);
			}
			// Next's control flow (a redirect) is rethrown by `toActionFailure` and is not a failure.
			if (!(failure instanceof ActionFailure)) return;
			handleFailure(failure.error, options, () => submitRef.current(variables));
		},
		onSuccess: (data, variables) => {
			const message =
				typeof options.successMessage === "function"
					? options.successMessage(data)
					: options.successMessage;
			if (message) toast.success(message);
			options.closes?.(false);
			options.onSuccess?.(data, variables);
		},
		onSettled: (data, _error, variables) => {
			inFlight.current = false;
			const keys =
				typeof options.invalidates === "function"
					? options.invalidates(data, variables)
					: options.invalidates;
			for (const queryKey of keys) {
				void queryClient.invalidateQueries({ queryKey });
			}
		},
	});

	const { mutate, isPending } = mutation;
	const submit = useCallback(
		(variables: V) => {
			if (inFlight.current || isPending) return;
			inFlight.current = true;
			mutate(variables);
		},
		[mutate, isPending],
	);
	useEffect(() => {
		submitRef.current = submit;
	}, [submit]);

	return { ...mutation, submit };
}

/** The toast's Retry action, re-invoking the failed mutation with its variables. */
function retryAction(retry: () => void): { action: { label: string; onClick: () => void } } {
	return { action: { label: "Retry", onClick: retry } };
}

/** The toast policy: one treatment per error kind; `retry` re-runs the failed call. */
function handleFailure<T, V, F extends FieldValues>(
	error: ActionError,
	options: ActionMutationOptions<T, V, F>,
	retry: () => void,
): void {
	switch (error.kind) {
		case "validation":
			if (options.form) {
				const { instance, fields } = options.form;
				applyFieldErrors(instance, error.fields, fields);
				// A validation result with no per-field message still has its summary sentence.
				if (!Object.values(error.fields).some((messages) => messages?.[0])) {
					instance.setError(ROOT_SERVER_ERROR, { type: "server", message: error.message });
				}
				return;
			}
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
			endSession();
			return;
		case "conflict":
		case "not-found":
		case "forbidden":
			if (options.onRefusal) {
				options.onRefusal(error);
				return;
			}
			toast.error(describeActionError(error));
			return;
		case "network":
			// Offline before the call, or a call that got no answer: the sentence says which. Only
			// the first is safe to retry — an unanswered call may already have applied.
			if (error.sent) toast.error(describeActionError(error));
			else toast.error(describeActionError(error), retryAction(retry));
			return;
		case "unexpected":
			toast.error(describeActionError(error), retryAction(retry));
	}
}
