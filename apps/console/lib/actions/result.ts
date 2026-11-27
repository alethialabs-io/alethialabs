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
	| { kind: "forbidden"; message: string; code?: string }
	| { kind: "not-found"; message: string; code?: string }
	| { kind: "conflict"; message: string; code?: string }
	| { kind: "entitlement"; message: string; feature: string }
	/**
	 * The call never produced a server answer. `sent` says whether the request left the browser:
	 * `false` means nothing was sent, so nothing changed; `true` means the outcome is unknown.
	 * The server never returns this kind. Only the client raises it, in {@link toActionFailure}.
	 */
	| { kind: "network"; sent: boolean }
	| { kind: "unexpected"; ref: string };

// `code` on a refusal kind is OPTIONAL and DOMAIN-OWNED: a machine-readable reason a domain attaches
// (e.g. an `ApprovalErrorCode` from lib/approvals/refusal.ts) so the one screen that knows the domain
// can branch on it — say which refusal happened — without parsing `message` or re-reading state to
// infer it (#7643). It is never shown and the toast policy never reads it; `kind` still decides the
// treatment. A client narrows it with the domain's own type guard, because the contract types it as
// a plain string so any action can carry one.

/** The one shape every server action returns. */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError };

/** The kinds an action's own code may raise on purpose (the rest are mapped by `defineAction`). */
export type DomainErrorKind = "not-found" | "conflict" | "entitlement";

/**
 * A domain refusal the action raises on purpose; `defineAction` maps it to its `kind`, and carries
 * `code` (when given) onto a `not-found` or `conflict` result for the client to branch on.
 */
export class ActionRefusal extends Error {
	/**
	 * Builds a refusal of `kind` whose `message` is safe to show the user verbatim. `feature` is the
	 * entitlement's feature; `code` is a domain's machine-readable reason (see `ActionError`).
	 */
	constructor(
		readonly kind: DomainErrorKind,
		message: string,
		readonly feature?: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "ActionRefusal";
	}
}

/**
 * A refusal about one or more FIELDS that only the server can decide — a slug another organization
 * already holds, a name taken since the form was loaded. `defineAction` maps it to a `validation`
 * result, so the client puts each message under its field exactly as it does for a schema failure,
 * instead of a toast that is gone while the value that caused it is still in the box (#6128).
 *
 * Every message is shown to the user verbatim; the keys are the form's field names.
 */
export class FieldRefusal extends Error {
	/** Builds a refusal; `message` is the summary, `fields` the per-field sentences. */
	constructor(
		readonly fields: FieldErrors,
		message: string,
	) {
		super(message);
		this.name = "FieldRefusal";
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

/** Shown when the browser was offline before the call: no request was made. */
export const NETWORK_OFFLINE_MESSAGE = "You appear to be offline. Nothing was changed.";

/** Shown when a call that was sent got no server answer: the change may or may not have applied. */
export const NETWORK_UNCONFIRMED_MESSAGE =
	"We couldn't confirm that change. Check it before trying again.";

/**
 * True when `thrown` is Next's own control flow (a redirect, `notFound()`, an HTTP fallback) and
 * not a failure. Next marks these with a `digest` that starts with a fixed prefix. This reads the
 * digest and does not import `unstable_rethrow`, because this module is loaded by client code
 * whose tests replace `next/navigation` with a partial mock.
 */
export function isFrameworkControlFlow(thrown: unknown): boolean {
	if (typeof thrown !== "object" || thrown === null || !("digest" in thrown)) return false;
	const digest = thrown.digest;
	if (typeof digest !== "string") return false;
	return (
		digest.startsWith("NEXT_REDIRECT") ||
		digest.startsWith("NEXT_HTTP_ERROR_FALLBACK") ||
		digest === "NEXT_NOT_FOUND"
	);
}

/**
 * Turns anything `await action()` can throw into an `ActionFailure`, so the client has one type
 * to route on. `sent` says whether the request left the browser.
 *
 * - An `ActionFailure` is returned as it is.
 * - Next's control flow is rethrown, so an action that redirects still navigates.
 * - Everything else is a call that got no server answer (the browser went offline, a proxy
 *   answered instead of the app, the page is older than the deployment) and becomes `network`.
 */
export function toActionFailure(thrown: unknown, sent: boolean): ActionFailure {
	if (thrown instanceof ActionFailure) return thrown;
	if (isFrameworkControlFlow(thrown)) throw thrown;
	return new ActionFailure({ kind: "network", sent });
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
		case "network":
			return error.sent ? NETWORK_UNCONFIRMED_MESSAGE : NETWORK_OFFLINE_MESSAGE;
		case "unexpected":
			return `Something went wrong on our side. Reference: ${error.ref}`;
	}
}

/** Builds a success result. */
export function ok<T>(data: T): ActionResult<T> {
	return { ok: true, data };
}
