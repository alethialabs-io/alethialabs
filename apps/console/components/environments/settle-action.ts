// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE ENVIRONMENT WRITES THIS UNIT DOES NOT OWN, ON THE MUTATION CONTRACT'S CLIENT HALF.
//
// Creating, duplicating and deleting an environment and its auto-heal switch are server actions in
// `app/server/actions/projects.ts`, which belongs to another unit and still answers in its own
// shapes: `addEnvironment` / `duplicateEnvironment` RETURN a name refusal (`{ ok: false, error }`),
// and `deleteEnvironment` / `setAutoHeal` THROW. `useActionMutation` takes an `ActionResult`, so
// these two adapters translate — on the client, without changing what the server returns — and the
// page gets the contract's pending state, double-submit guard, inline validation and invalidation
// for every write it makes. When the projects unit moves those actions onto `defineAction`, the
// adapters are deleted and the actions are passed to `useActionMutation` directly.

import type { ActionResult } from "@/lib/actions/result";
import { errorDigest } from "@/lib/errors";

/**
 * Runs a server action that THROWS on failure, as an `ActionResult`. A thrown failure is an
 * `unexpected` result whose reference is the production build's digest — the thrown message is
 * never shown, because a production build replaces it anyway and a dev build can carry internals.
 */
export async function settleThrown<T>(call: () => Promise<T>): Promise<ActionResult<T>> {
	try {
		return { ok: true, data: await call() };
	} catch (error) {
		return { ok: false, error: { kind: "unexpected", ref: errorDigest(error) ?? "client" } };
	}
}

/** A server action's own answer: a value, or a refusal sentence about one form field. */
export type FieldRefusalOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Runs a server action that RETURNS a refusal about one form field (`{ ok: false, error }`), as an
 * `ActionResult`: the refusal becomes a `validation` result on `field`, which `useActionMutation`
 * hands to the form rather than to a toast. A thrown failure is handled as in {@link settleThrown}.
 */
export async function settleFieldRefusal<T>(
	call: () => Promise<FieldRefusalOutcome<T>>,
	field: string,
): Promise<ActionResult<T>> {
	const settled = await settleThrown(call);
	if (!settled.ok) return settled;
	const outcome = settled.data;
	if (!outcome.ok) {
		return {
			ok: false,
			error: { kind: "validation", message: outcome.error, fields: { [field]: [outcome.error] } },
		};
	}
	return { ok: true, data: outcome.value };
}
