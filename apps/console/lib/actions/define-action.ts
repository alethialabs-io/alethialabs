// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { UnauthorizedError } from "@/lib/auth/errors";
import { ForbiddenError } from "@/lib/authz/types";
import {
	ActionRefusal,
	FieldRefusal,
	type ActionError,
	type ActionResult,
	type FieldErrors,
} from "@/lib/actions/result";

/** What an action's body receives: the parsed, typed input. */
export interface ActionContext<I> {
	input: I;
}

/** The definition `defineAction` turns into a callable server action. */
export interface ActionDefinition<S extends z.ZodType, T> {
	/** Validates the client's argument; a failure becomes a `validation` result with field errors. */
	input: S;
	/** The action body. Throw `ActionRefusal` for a domain refusal; return the success value. */
	run: (ctx: ActionContext<z.output<S>>) => Promise<T>;
}

/**
 * Wraps an action body in the contract (ADR 0005 §D4): parses input with zod, runs the body, and
 * maps every outcome onto `ActionResult<T>`.
 *
 * - Next's own control flow (`redirect()`, `notFound()`) is rethrown untouched by
 *   `unstable_rethrow`, so an action can still navigate.
 * - `ForbiddenError` (PDP deny) → `forbidden`; `UnauthorizedError` → `unauthenticated`.
 * - `ActionRefusal` → its declared kind, with its message shown verbatim.
 * - `FieldRefusal` → `validation`, with its per-field messages (a refusal only the server can
 *   decide, such as a slug another organization holds).
 * - Anything else → `unexpected` with a reference id that is logged server-side; the original
 *   message never reaches the client (internals and validator text do not leak — F013).
 *
 * The returned function is async, so it is a legal export of a `"use server"` module.
 */
export function defineAction<S extends z.ZodType, T>(
	def: ActionDefinition<S, T>,
): (raw: z.input<S>) => Promise<ActionResult<T>> {
	return async (raw) => {
		const parsed = def.input.safeParse(raw);
		if (!parsed.success) {
			return { ok: false, error: validationError(parsed.error) };
		}
		try {
			const data = await def.run({ input: parsed.data });
			return { ok: true, data };
		} catch (error) {
			unstable_rethrow(error);
			return { ok: false, error: mapThrown(error) };
		}
	};
}

/** Turns a zod error into a `validation` result keyed by field path. */
function validationError(error: z.ZodError): ActionError {
	const fields: FieldErrors = {};
	for (const issue of error.issues) {
		const key = issue.path.length > 0 ? issue.path.join(".") : "_form";
		const existing = fields[key] ?? [];
		existing.push(issue.message);
		fields[key] = existing;
	}
	const first = error.issues[0]?.message ?? "Check the highlighted fields.";
	return { kind: "validation", message: first, fields };
}

/** Maps a thrown value onto an `ActionError`; unknown errors are logged with a reference id. */
function mapThrown(error: unknown): ActionError {
	if (error instanceof ActionRefusal) {
		if (error.kind === "entitlement") {
			return { kind: "entitlement", message: error.message, feature: error.feature ?? "" };
		}
		return { kind: error.kind, message: error.message };
	}
	if (error instanceof FieldRefusal) {
		return { kind: "validation", message: error.message, fields: error.fields };
	}
	if (error instanceof ForbiddenError) {
		return { kind: "forbidden", message: "You don't have permission to do that." };
	}
	if (error instanceof UnauthorizedError) {
		return { kind: "unauthenticated" };
	}
	const ref = crypto.randomUUID().slice(0, 8);
	console.error(`[action] unexpected error ref=${ref}`, error);
	return { kind: "unexpected", ref };
}
