// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The consent step around Better Auth's OAuth consent call (AGT-L2, gaps G8 and G17).
//
// Better Auth's `mcp()` provider sends a person to the consent page with a SIGNED copy of the
// authorization request in the query (`client_id`, `scope`, `exp`, `sig`, …). Its own consent
// endpoint verifies that signature and records an `oauth_consent` row, but it knows nothing about
// organizations, projects or what the person's role allows, and it answers an expired and a
// tampered request with the same error. This module is the part it does not do:
//
//   · reading the request without trusting it (`parseConsentRequest`): the client and scopes are
//     shown, but nothing is granted until Better Auth has verified the signature on submit;
//   · telling an EXPIRED request (its signed `exp` has passed) from one ALREADY ANSWERED (an earlier
//     allow or deny recorded its digest) — G17;
//   · what may be granted in an org: requested ∩ the five agent scopes ∩ what the person's role in
//     that org allows (a scope only narrows the role, so offering one the role lacks would grant
//     nothing and mislead), refused outright where the org's kill switch is off or (Enterprise) its
//     allow-list leaves this client out;
//   · the grant row itself (`agent_oauth_grants`): org, scopes, projects — one per consent, replaced
//     on re-consent, kept with `revoked_at` on disconnect (grants.ts).
//
// The "already answered" marker lives in Better Auth's `verification` table under its own identifier
// prefix, with the request's own expiry, so it needs no table of its own and ages out with the
// request it describes.

import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNull, notExists, notInArray, sql } from "drizzle-orm";
import type { Executor } from "@/lib/approvals/binding";
import { readAgentPolicy } from "@/lib/approvals/context";
import { enterpriseAgentPolicy } from "@/lib/approvals/enterprise-policy";
import { AGENT_SCOPES, type AgentScope } from "@/lib/approvals/types";
import { OIDC_SCOPES } from "@/lib/auth/mcp-scopes";
import { getPdp } from "@/lib/authz";
import type { Action } from "@/lib/authz/registry";
import type { Actor } from "@/lib/authz/types";
import { isEnumMember } from "@/lib/coerce";
import type { Tx } from "@/lib/db";
import { getServiceDb } from "@/lib/db";
import { agentOauthGrants, oauthConsent, projects, verification } from "@/lib/db/schema";

/** The identifier prefix of an "already answered" marker in `verification`. */
export const CONSENT_ANSWERED_PREFIX = "agent-consent-answered:";

/** A consent request as read from the page's query, NOT yet verified (Better Auth verifies on submit). */
export interface ConsentRequest {
	clientId: string;
	/** Every scope the client asked for, as asked. */
	requestedScopes: string[];
	/** When the signed request stops being valid. */
	expiresAt: Date;
	/** A digest of the request's signature: the key its "already answered" marker is stored under. */
	key: string;
}

/** Reading the query: a request, or why there is none to answer. */
export type ConsentRequestReading =
	| { ok: true; request: ConsentRequest }
	| { ok: false; reason: "missing" | "malformed" | "expired" };

/**
 * Reads the signed authorization request the consent page was opened with. `missing` is a page
 * opened directly (no client); `malformed` lacks the signature or expiry Better Auth always adds;
 * `expired` has a signed expiry in the past. The signature itself is checked by Better Auth when the
 * answer is submitted, so a request read here is shown, never trusted.
 */
export function parseConsentRequest(oauthQuery: string, now: Date = new Date()): ConsentRequestReading {
	const params = new URLSearchParams(oauthQuery);
	const clientId = params.get("client_id");
	if (!clientId) return { ok: false, reason: "missing" };
	const sig = params.get("sig");
	const exp = Number(params.get("exp"));
	if (!sig || params.getAll("sig").length !== 1 || !Number.isFinite(exp) || exp <= 0) {
		return { ok: false, reason: "malformed" };
	}
	const expiresAt = new Date(exp * 1000);
	if (expiresAt.getTime() < now.getTime()) return { ok: false, reason: "expired" };
	const requestedScopes = (params.get("scope") ?? "").split(" ").filter(Boolean);
	return {
		ok: true,
		request: { clientId, requestedScopes, expiresAt, key: createHash("sha256").update(sig, "utf8").digest("hex") },
	};
}

/** The requested scopes, split into the agent scopes, the OpenID Connect ones and the rest. */
export interface RequestedScopes {
	agent: AgentScope[];
	oidc: string[];
	/** Scopes Alethia has no such permission for: shown as "not offered", never granted. */
	unknown: string[];
}

/** Splits `requested` (deduplicated, in the order asked). */
export function partitionRequestedScopes(requested: readonly string[]): RequestedScopes {
	const out: RequestedScopes = { agent: [], oidc: [], unknown: [] };
	for (const scope of new Set(requested)) {
		if (isEnumMember(scope, AGENT_SCOPES)) out.agent.push(scope);
		else if (isEnumMember(scope, OIDC_SCOPES)) out.oidc.push(scope);
		else out.unknown.push(scope);
	}
	return out;
}

/** The project verb each agent scope stands for (the scope ceiling's mapping, lib/authz/scope-ceiling.ts). */
export const SCOPE_VERB: Record<AgentScope, Action> = {
	read: "view",
	design: "edit",
	plan: "plan",
	apply: "deploy",
	destroy: "destroy",
};

/** The agent scopes `actor`'s role allows in their org, asked of the PDP as org-wide project verbs. */
export async function scopesRoleAllows(actor: Actor): Promise<AgentScope[]> {
	const pdp = getPdp();
	const answers = await Promise.all(
		AGENT_SCOPES.map(async (scope) => ((await pdp.can(actor, SCOPE_VERB[scope], { type: "project" })).allowed ? scope : null)),
	);
	return answers.filter((s): s is AgentScope => s !== null);
}

/** The scopes that may be granted: requested ∩ known agent scopes ∩ what the role allows. */
export function grantableScopes(requested: readonly AgentScope[], roleAllows: readonly AgentScope[]): AgentScope[] {
	return requested.filter((s) => roleAllows.includes(s));
}

/** Why an org cannot be connected to this client at all. */
export type OrgConsentRefusal = "agent_access_disabled" | "client_not_allowed";

/**
 * Whether `orgId` refuses `clientId` outright: its kill switch is off, or (Enterprise) its allow-list
 * of OAuth clients leaves the client out — asked through the same seam the queue gate and the
 * decision re-check use (lib/approvals/enterprise-policy.ts), so core never interprets the column.
 */
export async function orgConsentRefusal(db: Executor, orgId: string, clientId: string): Promise<OrgConsentRefusal | null> {
	const policy = await readAgentPolicy(db, orgId);
	if (!policy.agentAccessEnabled) return "agent_access_disabled";
	const enterprise = await enterpriseAgentPolicy();
	if (enterprise && (await enterprise.oauthClientRefusal(orgId, policy, clientId))) return "client_not_allowed";
	return null;
}

/** True when an allow or deny for request `key` has already been recorded and has not aged out. */
export async function consentAlreadyAnswered(key: string, now: Date = new Date()): Promise<boolean> {
	const [row] = await getServiceDb()
		.select({ id: verification.id })
		.from(verification)
		.where(and(eq(verification.identifier, CONSENT_ANSWERED_PREFIX + key), gt(verification.expiresAt, now)))
		.limit(1);
	return !!row;
}

/** Records that request `key` was answered (`allowed` or `denied`), until the request itself expires. */
export async function markConsentAnswered(key: string, outcome: "allowed" | "denied", expiresAt: Date): Promise<void> {
	await getServiceDb().insert(verification).values({ identifier: CONSENT_ANSWERED_PREFIX + key, value: outcome, expiresAt });
}

/**
 * The projects among `projectIds` that are `orgId`'s and that `actor` may view. A grant may only name
 * those; anything else in the request is dropped by the caller's equality check.
 */
export async function grantableProjectIds(
	orgId: string,
	projectIds: readonly string[],
	viewable: readonly string[],
): Promise<string[]> {
	if (projectIds.length === 0) return [];
	const rows = await getServiceDb()
		.select({ id: projects.id })
		.from(projects)
		.where(and(eq(projects.org_id, orgId), inArray(projects.id, [...projectIds])));
	return rows.map((r) => r.id).filter((id) => viewable.includes(id));
}

/** What the person chose on the consent screen, after it was checked. */
export interface GrantChoice {
	orgId: string;
	userId: string;
	clientId: string;
	scopes: AgentScope[];
	/** null means every project in the org, present and future. */
	projectIds: string[] | null;
}

/**
 * Writes the grant for the consent Better Auth just recorded for (`clientId`, `userId`), in `db`
 * opened in the person's scope for `orgId` (RLS: the grant is theirs and in that org). One grant per
 * consent: a re-consent replaces the scopes, projects and org, and clears any earlier revocation.
 * Returns the grant id, or null when no consent row exists (Better Auth did not record one).
 */
export async function writeGrantForConsent(db: Tx, choice: GrantChoice): Promise<string | null> {
	const [consent] = await getServiceDb()
		.select({ id: oauthConsent.id })
		.from(oauthConsent)
		.where(and(eq(oauthConsent.clientId, choice.clientId), eq(oauthConsent.userId, choice.userId), isNull(oauthConsent.referenceId)))
		.orderBy(sql`${oauthConsent.updatedAt} desc`)
		.limit(1);
	if (!consent) return null;
	const values = {
		org_id: choice.orgId,
		user_id: choice.userId,
		client_id: choice.clientId,
		scopes: [...choice.scopes],
		project_ids: choice.projectIds === null ? null : [...choice.projectIds],
	};
	const [grant] = await db
		.insert(agentOauthGrants)
		.values({ consent_id: consent.id, ...values })
		.onConflictDoUpdate({
			target: agentOauthGrants.consent_id,
			set: { ...values, revoked_at: null, updated_at: sql`now()` },
		})
		.returning({ id: agentOauthGrants.id });
	return grant?.id ?? null;
}

/** The fields of one `oauth_consent` row that Better Auth's consent call writes. */
interface ConsentRowState {
	id: string;
	scopes: string[];
	resources: string[] | null;
	requestedUserInfoClaims: string[] | null;
	updatedAt: Date;
}

/**
 * The person's consent rows for a client as they stood BEFORE Better Auth's consent call: what
 * `restoreConsent` puts back when the grant that belongs with the answer cannot be written.
 */
export interface ConsentSnapshot {
	clientId: string;
	userId: string;
	rows: ConsentRowState[];
}

/** Reads the person's consent rows for `clientId`, before the consent call that may change them. */
export async function readConsentSnapshot(clientId: string, userId: string): Promise<ConsentSnapshot> {
	const rows = await getServiceDb()
		.select({
			id: oauthConsent.id,
			scopes: oauthConsent.scopes,
			resources: oauthConsent.resources,
			requestedUserInfoClaims: oauthConsent.requestedUserInfoClaims,
			updatedAt: oauthConsent.updatedAt,
		})
		.from(oauthConsent)
		.where(and(eq(oauthConsent.clientId, clientId), eq(oauthConsent.userId, userId)));
	return { clientId, userId, rows };
}

/**
 * Puts the person's consent rows for the snapshot's client back as they were: a row the consent call
 * created is deleted (unless a grant was written for it meanwhile), and a row it updated gets its
 * earlier scopes, resources and claims again. The
 * consent and its grant are recorded together or not at all, so this runs whenever the grant was not
 * written. One transaction, on the service connection (Better Auth's rows carry no tenant column).
 */
export async function restoreConsent(snapshot: ConsentSnapshot): Promise<void> {
	const ids = snapshot.rows.map((r) => r.id);
	await getServiceDb().transaction(async (tx) => {
		const mine = and(eq(oauthConsent.clientId, snapshot.clientId), eq(oauthConsent.userId, snapshot.userId));
		// A row with a grant beside it was answered in full (another tab, say) and is never deleted
		// here: deleting it would take its grant with it.
		const ungranted = notExists(
			tx.select({ id: agentOauthGrants.id }).from(agentOauthGrants).where(eq(agentOauthGrants.consent_id, oauthConsent.id)),
		);
		await tx
			.delete(oauthConsent)
			.where(ids.length === 0 ? and(mine, ungranted) : and(mine, ungranted, notInArray(oauthConsent.id, ids)));
		for (const row of snapshot.rows) {
			await tx
				.update(oauthConsent)
				.set({
					scopes: row.scopes,
					resources: row.resources,
					requestedUserInfoClaims: row.requestedUserInfoClaims,
					updatedAt: row.updatedAt,
				})
				.where(and(mine, eq(oauthConsent.id, row.id)));
		}
	});
}

/** The person's live grant to `clientId` in `orgId`, for the re-consent diff; null when none. */
export async function existingGrant(
	db: Tx,
	orgId: string,
	userId: string,
	clientId: string,
): Promise<{ scopes: AgentScope[]; projectIds: string[] | null; createdAt: string } | null> {
	const [row] = await db
		.select({ scopes: agentOauthGrants.scopes, project_ids: agentOauthGrants.project_ids, created_at: agentOauthGrants.created_at })
		.from(agentOauthGrants)
		.where(
			and(
				eq(agentOauthGrants.org_id, orgId),
				eq(agentOauthGrants.user_id, userId),
				eq(agentOauthGrants.client_id, clientId),
				isNull(agentOauthGrants.revoked_at),
			),
		)
		.limit(1);
	return row ? { scopes: row.scopes, projectIds: row.project_ids, createdAt: row.created_at.toISOString() } : null;
}

/**
 * The redirect URL in Better Auth's consent answer. Its JSON shape has varied between versions
 * (`url`, `redirect_uri`, `redirectURI`), so each is read; anything else is no URL.
 */
export function consentRedirectUrl(answer: unknown): string | null {
	if (typeof answer !== "object" || answer === null) return null;
	for (const key of ["url", "redirect_uri", "redirectURI"]) {
		const value: unknown = Reflect.get(answer, key);
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}
