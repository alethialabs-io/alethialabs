// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The seam between the pull-request loop and a git host.
//
// Everything the loop does on a git host goes through `GitProviderAdapter`: read the design file,
// open or update a change request, keep one comment current, report a check, verify an inbound
// delivery, mint a token for one repository, and answer whether a branch is protected. GitHub is
// the first host to be written against it (lib/git/github-app/**); GitLab and Bitbucket can be
// written against it later without the loop changing.
//
// This file is a CONTRACT. It makes no network call and reads no configuration, so both the server
// and a test double can import it. The vocabulary is the host-neutral one — "change request" for a
// pull or merge request, "check" for a check run or a commit status — because the callers must not
// learn one host's words.
//
// NAMING. The interface is `GitProviderAdapter`, not `GitProvider`: `GitProvider` already names the
// provider SLUG app-wide (`"github" | "gitlab" | "bitbucket"`, lib/db/schema/enums.ts), and two
// exported types with one name and two meanings is how an auto-import picks the wrong one.

import type { GitProvider } from "@/lib/db/schema";

// ── Results ───────────────────────────────────────────────────────────────────────────────

/**
 * Why a provider call did not do what was asked. A closed list, so a caller's `switch` is checked
 * by the compiler and an adapter cannot invent a seventh outcome.
 *
 *   - `not_found`         — the repository, branch, ref or change request does not exist, or the
 *                           connection cannot see it (a host does not tell those apart).
 *   - `permission_denied` — the connection exists but was not granted what the call needs.
 *   - `conflict`          — the thing moved under the caller: a file changed since it was read, a
 *                           branch is not where the caller said it was.
 *   - `rate_limited`      — the host asked us to slow down; `retryAfterSeconds` says for how long
 *                           when the host said.
 *   - `unavailable`       — the host did not answer, or answered with a server error.
 *   - `unsupported`       — this host has no equivalent of the operation.
 */
export const GIT_PROVIDER_FAILURE_REASONS = [
	"not_found",
	"permission_denied",
	"conflict",
	"rate_limited",
	"unavailable",
	"unsupported",
] as const;

/** One of {@link GIT_PROVIDER_FAILURE_REASONS}. */
export type GitProviderFailureReason = (typeof GIT_PROVIDER_FAILURE_REASONS)[number];

/** A provider call that did not succeed. `message` is for logs and operators, never for a check. */
export interface GitProviderFailure {
	ok: false;
	reason: GitProviderFailureReason;
	message: string;
	/** Present only for `rate_limited`, and only when the host stated a wait. */
	retryAfterSeconds?: number;
}

/** The outcome of a provider call: the value, or a typed refusal. Adapters do not throw for these. */
export type GitProviderResult<T> = { ok: true; value: T } | GitProviderFailure;

/** Wraps a value as a successful provider result. */
export function gitOk<T>(value: T): GitProviderResult<T> {
	return { ok: true, value };
}

/** Builds a provider failure. `retryAfterSeconds` is kept only when it is a positive whole number. */
export function gitFailure(
	reason: GitProviderFailureReason,
	message: string,
	retryAfterSeconds?: number,
): GitProviderFailure {
	if (
		retryAfterSeconds !== undefined &&
		Number.isInteger(retryAfterSeconds) &&
		retryAfterSeconds > 0
	) {
		return { ok: false, reason, message, retryAfterSeconds };
	}
	return { ok: false, reason, message };
}

/**
 * True when the same call may succeed later without anything else changing: the host was busy or
 * asked for a pause. Every other reason needs a different input or a different grant first.
 */
export function isRetryableGitFailure(failure: GitProviderFailure): boolean {
	return failure.reason === "rate_limited" || failure.reason === "unavailable";
}

// ── Addressing ────────────────────────────────────────────────────────────────────────────

/**
 * One repository, reached through the connection that grants access to it.
 *
 * `installationId` and `repositoryId` are the HOST's identifiers, as strings. They come from our
 * own rows (an installation bound to an organization, a repository that installation lists) —
 * never from a URL or a request body. `owner` and `name` are what the host calls it today and can
 * change on a rename; `repositoryId` does not.
 */
export interface GitRepoRef {
	installationId: string;
	repositoryId: string;
	owner: string;
	name: string;
}

// ── readFile ──────────────────────────────────────────────────────────────────────────────

/** Which file to read. `ref` is a commit SHA, a branch or a tag; pass a SHA to pin the read. */
export interface ReadFileInput {
	repo: GitRepoRef;
	path: string;
	ref: string;
}

/**
 * A text file as it is at a ref. `blobSha` is the host's content identity for the file: two reads
 * with the same `blobSha` returned the same bytes, which is how "the merged file is the planned
 * file" is decided without comparing text.
 */
export interface GitFile {
	path: string;
	ref: string;
	blobSha: string;
	content: string;
}

// ── openChangeRequest ─────────────────────────────────────────────────────────────────────

/**
 * One file to write on the head branch. `expectedBlobSha` is the `blobSha` the new content was
 * rendered from: a string when the file existed, `null` when the caller expects to create it, and
 * left out to write unconditionally. When it is given and the file on the head branch's starting
 * point is something else, the call fails with `conflict` and writes nothing.
 */
export interface GitFileWrite {
	path: string;
	content: string;
	expectedBlobSha?: string | null;
}

/**
 * A change request to open, or to bring up to date.
 *
 * The call is idempotent on `headBranch`: it creates the branch from `baseBranch` when it does not
 * exist, commits `files` to it, and opens a change request into `baseBranch` — or, when one is
 * already open from that head, adds the commit to it and updates its title and body. The head
 * branch is always in the SAME repository as the base.
 */
export interface OpenChangeRequestInput {
	repo: GitRepoRef;
	baseBranch: string;
	headBranch: string;
	title: string;
	body: string;
	commitMessage: string;
	files: GitFileWrite[];
}

/** The change request after the call. `created` is false when an open one was updated. */
export interface ChangeRequestRef {
	number: number;
	url: string;
	headBranch: string;
	headSha: string;
	created: boolean;
}

// ── upsertComment ─────────────────────────────────────────────────────────────────────────

/**
 * The one comment a change request carries for a given `key`, created or edited in place.
 *
 * `key` names the comment's purpose (the plan summary, say) and is how the adapter finds its own
 * earlier comment; `commentId` is the id a previous call returned, and lets the adapter skip the
 * search. A second call with the same `key` never produces a second comment.
 */
export interface UpsertCommentInput {
	repo: GitRepoRef;
	changeRequestNumber: number;
	key: string;
	body: string;
	commentId?: string;
}

/** The comment after the call. `created` is false when an existing one was edited. */
export interface CommentRef {
	commentId: string;
	created: boolean;
}

// ── setCheck ──────────────────────────────────────────────────────────────────────────────

/**
 * How a finished check ended.
 *
 *   - `success`         — the plan was computed and nothing blocks it.
 *   - `failure`         — the plan could not be computed, or verification refused it.
 *   - `neutral`         — nothing was planned, on purpose, and the summary says why.
 *   - `action_required` — a person has to act in the console before anything proceeds.
 */
export const GIT_CHECK_CONCLUSIONS = ["success", "failure", "neutral", "action_required"] as const;

/** One of {@link GIT_CHECK_CONCLUSIONS}. */
export type GitCheckConclusion = (typeof GIT_CHECK_CONCLUSIONS)[number];

/** Where a check is. A conclusion exists exactly when the check is completed. */
export type GitCheckState =
	| { status: "queued" }
	| { status: "in_progress" }
	| { status: "completed"; conclusion: GitCheckConclusion };

/**
 * A check to create or move forward on one commit.
 *
 * Pass the `checkId` a previous call returned to update that check; leave it out to create one.
 * `externalId` is our own identifier for the work behind the check and is echoed back in the
 * host's events about it. `title` and `summary` are shown on the host to everyone who can see the
 * repository, so the caller renders them from an allow-list of fields before they get here.
 */
export interface SetCheckInput {
	repo: GitRepoRef;
	headSha: string;
	name: string;
	state: GitCheckState;
	title: string;
	summary: string;
	detailsUrl?: string;
	externalId?: string;
	checkId?: string;
}

/** The check after the call. */
export interface CheckRef {
	checkId: string;
}

// ── verifyWebhook ─────────────────────────────────────────────────────────────────────────

/** The request headers, read case-insensitively. A Fetch `Headers` satisfies it. */
export interface WebhookHeaders {
	get(name: string): string | null;
}

/**
 * An inbound delivery exactly as it arrived. `rawBody` is the bytes of the request body before
 * anything parsed them — the signature is computed over those bytes, not over a re-serialisation.
 */
export interface VerifyWebhookInput {
	rawBody: Uint8Array;
	headers: WebhookHeaders;
}

/**
 * Why a delivery was not accepted. Each is a refusal reached before the payload is used:
 * the signature header is absent, the signature does not match the body, the delivery carries no
 * id to deduplicate on, it does not name its event, or the verified body is not the JSON object a
 * delivery must be.
 */
export const WEBHOOK_REFUSAL_REASONS = [
	"missing_signature",
	"bad_signature",
	"missing_delivery_id",
	"missing_event",
	"malformed_payload",
] as const;

/** One of {@link WEBHOOK_REFUSAL_REASONS}. */
export type WebhookRefusalReason = (typeof WEBHOOK_REFUSAL_REASONS)[number];

/**
 * A delivery whose signature matched.
 *
 * `deliveryId` is the host's id for the delivery and is the same on a redelivery, so it is the key
 * a delivery is claimed under. `event` and `action` are the host's own names. `installationId` is
 * read from INSIDE the verified body and is the only thing a tenant may be resolved from; it is
 * null for a delivery that concerns no installation. `payload` is the parsed body, still untyped:
 * whoever handles the event narrows it.
 */
export interface VerifiedWebhookDelivery {
	provider: GitProvider;
	deliveryId: string;
	event: string;
	action: string | null;
	installationId: string | null;
	payload: unknown;
}

/** The outcome of {@link GitProviderAdapter.verifyWebhook}. */
export type WebhookVerification =
	| { ok: true; delivery: VerifiedWebhookDelivery }
	| { ok: false; reason: WebhookRefusalReason };

// ── mintRepoToken ─────────────────────────────────────────────────────────────────────────

/**
 * A token to mint for ONE repository. `contents` is the most the token may do with the repository's
 * files: `read` to clone or read, `write` to push a branch. A caller asks for `read` unless the job
 * it is minting for writes.
 */
export interface MintRepoTokenInput {
	repo: GitRepoRef;
	contents: "read" | "write";
}

/**
 * A short-lived token for one repository. It is handed to the job that asked and is never stored
 * or logged; `expiresAt` is when the host stops accepting it.
 */
export interface RepoToken {
	token: string;
	expiresAt: Date;
}

// ── getBranchProtection ───────────────────────────────────────────────────────────────────

/** Which branch to ask about. */
export interface GetBranchProtectionInput {
	repo: GitRepoRef;
	branch: string;
}

/**
 * Whether the host protects a branch, as far as this connection can tell.
 *
 * `unknown` is a real answer and not an error: the grants this connection holds do not let it say.
 * An adapter returns `unknown` rather than asking for a wider grant to find out, and a caller
 * deciding whether a merge counts as an approval treats `unknown` exactly as `unprotected` — the
 * merge then produces an approval request in the console instead.
 */
export interface BranchProtection {
	state: "protected" | "unprotected" | "unknown";
}

// ── The interface ─────────────────────────────────────────────────────────────────────────

/**
 * A git host, as the pull-request loop sees it.
 *
 * Every method except `verifyWebhook` returns a {@link GitProviderResult}: an expected refusal from
 * the host is a value, not an exception, so a caller cannot forget the case. An adapter throws only
 * for a bug.
 */
export interface GitProviderAdapter {
	/** The provider this adapter speaks to. */
	readonly provider: GitProvider;

	/**
	 * Reads a text file at a ref. A file that is not there at that ref is `value: null` — an answer,
	 * not a failure; `not_found` is for a repository or ref that is missing.
	 */
	readFile(input: ReadFileInput): Promise<GitProviderResult<GitFile | null>>;

	/** Opens a change request from a branch in the same repository, or updates the open one. */
	openChangeRequest(input: OpenChangeRequestInput): Promise<GitProviderResult<ChangeRequestRef>>;

	/** Creates the keyed comment on a change request, or edits it in place. */
	upsertComment(input: UpsertCommentInput): Promise<GitProviderResult<CommentRef>>;

	/** Creates a check on a commit, or moves an existing one forward. */
	setCheck(input: SetCheckInput): Promise<GitProviderResult<CheckRef>>;

	/**
	 * Verifies an inbound delivery against the raw request body. Nothing may read the body before
	 * this returns `ok: true`, and a refusal carries no part of it.
	 */
	verifyWebhook(input: VerifyWebhookInput): Promise<WebhookVerification>;

	/** Mints a short-lived token limited to one repository and one level of access to its files. */
	mintRepoToken(input: MintRepoTokenInput): Promise<GitProviderResult<RepoToken>>;

	/** Says whether a branch is protected, or that this connection cannot tell. */
	getBranchProtection(input: GetBranchProtectionInput): Promise<GitProviderResult<BranchProtection>>;
}
