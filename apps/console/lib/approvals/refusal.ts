// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The refusals the approval engine raises. A leaf module (no imports), so lib/approvals/types.ts can
// re-export the queue gate's refusal while the engine imports it without an import cycle.

/** Why an apply or a destroy was refused, for a client to branch on without reading the message. */
export const APPLY_REFUSAL_CODES = [
	"approval_required",
	"approval_invalid",
	"not_permitted",
] as const;

/** One of {@link APPLY_REFUSAL_CODES}. */
export type ApplyRefusalCode = (typeof APPLY_REFUSAL_CODES)[number];

/**
 * The refusal `requireApplyAuthorization` throws. Typed so the two edges that queue for a caller can
 * answer it as a refusal rather than a fault: `refusalAsValue` (app/server/actions/projects.ts)
 * returns its message, and `POST /api/jobs` answers 403 with `code`. Its message is shown to the
 * user, so it is a sentence for a person.
 */
export class ApplyAuthorizationError extends Error {
	/** The machine-readable reason. */
	readonly code: ApplyRefusalCode;

	/** Builds the refusal from its reason and the sentence to show. */
	constructor(code: ApplyRefusalCode, message: string) {
		super(message);
		this.name = "ApplyAuthorizationError";
		this.code = code;
	}
}

/**
 * Why an approval could not be requested, read or decided. Each maps to one HTTP status in the
 * approvals API (app/api/approvals/**), so a client can branch on it; the decision action
 * (app/server/actions/approvals.ts) shows the same reasons as refusals.
 */
const APPROVAL_ERROR_CODES = {
	/** The approval or plan does not exist in the caller's org, or the caller may not see it. */
	not_found: 404,
	/** The plan cannot be approved as it stands (not succeeded, no digest, failed verify, not current). */
	plan_not_approvable: 409,
	/** The org's agent policy refuses this credential this operation here. */
	not_permitted: 403,
	/** Only a person signed in to the console decides an approval. */
	not_a_person: 403,
	/** The console session is too old to decide; sign in again. */
	reauthentication_required: 403,
	/** The org requires a different person than the requester to approve. */
	self_approval: 403,
	/** The approval is no longer pending (decided, expired, superseded or used). */
	not_pending: 409,
	/** The typed environment name for a destroy does not match. */
	confirmation_mismatch: 400,
} as const;

/** One of the keys of {@link APPROVAL_ERROR_CODES}. */
export type ApprovalErrorCode = keyof typeof APPROVAL_ERROR_CODES;

/** A refusal from requesting, reading or deciding an approval. Its message is shown to a person. */
export class ApprovalError extends Error {
	/** The machine-readable reason. */
	readonly code: ApprovalErrorCode;

	/** Builds the refusal from its reason and the sentence to show. */
	constructor(code: ApprovalErrorCode, message: string) {
		super(message);
		this.name = "ApprovalError";
		this.code = code;
	}

	/** The HTTP status the approvals API answers this refusal with. */
	get status(): number {
		return APPROVAL_ERROR_CODES[this.code];
	}
}
