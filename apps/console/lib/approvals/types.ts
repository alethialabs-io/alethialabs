// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The apply-authorization seam: the one question asked wherever a job that applies or destroys
// infrastructure is queued, and the vocabulary that question is asked in.
//
// THIS FILE DECIDES NOTHING YET. `requireApplyAuthorization` below allows every call, so placing
// it changed no behaviour. What this file fixes is WHERE the question is asked and WHAT it is
// told, so the rule can arrive later without editing a queueing site. Which files queue such a
// job, and which of them ask, is held by tests/lib/approvals/apply-authorization.test.ts.
//
// Runtime-dependency-free on purpose (its imports are types): app/server/actions/projects.ts
// imports it, and more than fifty test files load that module behind their own mocks.

import type { Actor } from "@/lib/authz/types";
import type { Tx } from "@/lib/db";

/** The two operations that need the question asked. A plan never does. */
export const APPLY_OPERATIONS = ["deploy", "destroy"] as const;

/** One of {@link APPLY_OPERATIONS}. */
export type ApplyOperation = (typeof APPLY_OPERATIONS)[number];

/** What a token may be limited to, from least to most. `apply` and `destroy` unlock a request. */
export const AGENT_SCOPES = ["read", "design", "plan", "apply", "destroy"] as const;

/** One of {@link AGENT_SCOPES}. */
export type AgentScope = (typeof AGENT_SCOPES)[number];

/** The states of an approval. Only `approved` can be consumed, and only once. */
export const APPROVAL_STATUSES = [
	"pending",
	"approved",
	"rejected",
	"expired",
	"superseded",
	"consumed",
] as const;

/** One of {@link APPROVAL_STATUSES}. */
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * The paths that queue an apply or a destroy with no actor behind the request: the job is a
 * consequence of something already decided, or of a rule the org switched on.
 *
 * - `build_chain` — the DEPLOY queued when a BUILD job succeeds (lib/jobs/finalize-build.ts).
 * - `promotion` — the DEPLOY queued when a promotion's gates pass (lib/promotions/lifecycle.ts).
 * - `auto_heal` — the DEPLOY that reconciles a drifted environment (lib/reconcile/auto-heal.ts).
 * - `ephemeral_reap` — the DESTROY of an expired ephemeral environment (lib/reconcile/reap.ts).
 */
export const SYSTEM_APPLY_ORIGINS = [
	"build_chain",
	"promotion",
	"auto_heal",
	"ephemeral_reap",
] as const;

/** One of {@link SYSTEM_APPLY_ORIGINS}. */
export type SystemApplyOrigin = (typeof SYSTEM_APPLY_ORIGINS)[number];

/**
 * Who is behind a queued apply or destroy: an actor (a person, or a credential acting for one),
 * or a named system path. A union on `kind`, so a system path cannot be mistaken for an actor
 * with fields missing.
 */
export type ApplyRequester =
	| { kind: "actor"; actor: Actor }
	| { kind: "system"; origin: SystemApplyOrigin };

/** What the job is aimed at, and the job itself. */
export interface ApplyTarget {
	orgId: string;
	projectId: string;
	environmentId: string;
	/**
	 * The job just inserted in `tx`, which stands only if this call returns. It is a DEPLOY or a
	 * DESTROY, or the BUILD whose success queues a DEPLOY of the same snapshot.
	 */
	jobId: string;
	/** The reviewed PLAN job a DEPLOY applies, when the caller named one. */
	planJobId?: string;
	/**
	 * Set on a DESTROY queued because another environment's destroy cascaded to this one: the
	 * environment the caller asked to destroy.
	 */
	cascadeOfEnvironmentId?: string;
}

/** What {@link requireApplyAuthorization} answers when the job may stand. */
export interface ApplyAuthorization {
	/** The approval this job consumed, or null when it needed none. */
	approvalId: string | null;
}

/** Why an apply or a destroy was refused, for a client to branch on without reading the message. */
export const APPLY_REFUSAL_CODES = [
	"approval_required",
	"approval_invalid",
	"not_permitted",
] as const;

/** One of {@link APPLY_REFUSAL_CODES}. */
export type ApplyRefusalCode = (typeof APPLY_REFUSAL_CODES)[number];

/**
 * The refusal {@link requireApplyAuthorization} throws. Typed so the two edges that queue for a
 * caller can answer it as a refusal rather than a fault: `refusalAsValue`
 * (app/server/actions/projects.ts) returns its message, and `POST /api/jobs` answers 403 with
 * `code`. Its message is shown to the user, so it is a sentence for a person.
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
 * May this apply or destroy be queued? Called once for every job a queueing site inserts, INSIDE
 * the transaction that inserted it and before anything else is written for it, so a refusal
 * (an {@link ApplyAuthorizationError}) rolls the job back and nothing is left queued.
 *
 * It is handed the transaction and the inserted job's id so that whatever it later has to record
 * against that job commits or rolls back with the job. `approvalId` is the approval the caller
 * presents, when it has one.
 *
 * TODAY IT ALLOWS EVERYTHING and reads none of its arguments: every call answers
 * `{ approvalId: null }`, whoever asks and whatever is presented. A caller that passes an
 * `approvalId` is therefore not yet checked against it.
 */
export async function requireApplyAuthorization(
	_tx: Tx,
	_requester: ApplyRequester,
	_operation: ApplyOperation,
	_target: ApplyTarget,
	_approvalId?: string | null,
): Promise<ApplyAuthorization> {
	return { approvalId: null };
}
