// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE MUTATION CONTRACT (ADR 0005 §D4, #6113). Every server action returns `ActionResult<T>`;
// nothing a user can act on is communicated by a thrown error. Before this, ~43 action modules
// threw, ~11 returned an ad-hoc `{ error }`, and the client read `e.message` into a toast — which
// is how `[body.data.name] Too small: expected string to have >=1 characters` reached a user (F013).
//
// Shared by the server (`define-action.ts`) and the client (`use-action-mutation.ts`), so it holds
// types and plain classes only: no `server-only`, no React.

/** Field-level validation messages, keyed by the form field's name (react-hook-form's path). */
export interface FieldErrors {
	[field: string]: string[] | undefined;
}

/**
 * Why an action did not succeed. Each kind has exactly one client treatment (the toast policy in
 * `use-action-mutation.ts`), which is the point of naming them: the UI decides by `kind`, never by
 * parsing a message.
 */
export type ActionError =
	| { kind: "validation"; message: string; fields: FieldErrors }
	| { kind: "unauthenticated" }
	| { kind: "forbidden"; message: string }
	| { kind: "not-found"; message: string }
	| { kind: "conflict"; message: string }
	| { kind: "entitlement"; message: string; feature: string }
	| { kind: "unexpected"; ref: string };

/** The one shape every server action returns. */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError };

/** The kinds an action's own code may raise on purpose (the rest are mapped by `defineAction`). */
export type DomainErrorKind = "not-found" | "conflict" | "entitlement";

/** A domain refusal the action raises on purpose; `defineAction` maps it to its `kind`. */
export class ActionRefusal extends Error {
	/** Builds a refusal of `kind` whose `message` is safe to show the user verbatim. */
	constructor(
		readonly kind: DomainErrorKind,
		message: string,
		readonly feature?: string,
	) {
		super(message);
		this.name = "ActionRefusal";
	}
}

/** A failed result raised on the client so TanStack's `onError` + rollback path runs. */
export class ActionFailure extends Error {
	/** Wraps the server's `ActionError`; `message` is a human sentence for logs, never parsed. */
	constructor(readonly error: ActionError) {
		super(describeActionError(error));
		this.name = "ActionFailure";
	}
}

/** A one-line human description of an action error, for logs and the fallback toast. */
export function describeActionError(error: ActionError): string {
	switch (error.kind) {
		case "validation":
			return error.message;
		case "unauthenticated":
			return "Your session has ended. Sign in again.";
		case "forbidden":
		case "not-found":
		case "conflict":
		case "entitlement":
			return error.message;
		case "unexpected":
			return `Something went wrong on our side. Reference: ${error.ref}`;
	}
}

/** Builds a success result. */
export function ok<T>(data: T): ActionResult<T> {
	return { ok: true, data };
}
