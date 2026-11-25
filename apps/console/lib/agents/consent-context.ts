// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// Everything the consent screen shows before the person decides (AGT-L2, SPEC §5b), read for the
// signed-in person: which app is asking and whether Alethia could confirm who publishes it, what it
// asked for (split into the agent scopes, sign-in scopes and scopes Alethia has no such permission
// for), and per organization the person belongs to — whether the org refuses the app outright, what
// the person's role there lets them grant, its projects, and the connection they already have there.
//
// It reads; it grants nothing. The answer is the `answerAgentConsent` server action.

import { eq, inArray, and } from "drizzle-orm";
import { readAgentPolicy } from "@/lib/approvals/context";
import type { AgentScope } from "@/lib/approvals/types";
import { getActiveScope } from "@/lib/auth/scope";
import { actorWithCredential } from "@/lib/authz/actor-credential";
import { type AgentAppIdentity, agentAppIdentity } from "@/lib/agents/catalog";
import {
	consentAlreadyAnswered,
	existingGrant,
	grantableScopes,
	type OrgConsentRefusal,
	orgConsentRefusal,
	parseConsentRequest,
	partitionRequestedScopes,
	type RequestedScopes,
	scopesRoleAllows,
} from "@/lib/agents/consent";
import { getServiceDb, withActorScope } from "@/lib/db";
import { member, oauthClient, organization, projects } from "@/lib/db/schema";
import { viewableProjectIds } from "@/lib/jobs/visibility";

/** One organization the person could connect the app in. */
export interface ConsentOrg {
	id: string;
	name: string;
	/** The person's role there, as the membership row names it (`owner`, `admin`, …, or a custom role). */
	role: string;
	/** True for the person's own workspace (no organization). */
	personal: boolean;
	/** Why this org refuses the app outright, or null. */
	refusal: OrgConsentRefusal | null;
	/** Informational: the org keeps agents off production. */
	agentsKeptOffProduction: boolean;
	/** The agent scopes the person's role there allows. */
	roleAllows: AgentScope[];
	/** requested ∩ roleAllows: what may be ticked. */
	grantable: AgentScope[];
	/** The projects the person may view there, by name. */
	projects: { id: string; name: string }[];
	/** The person's live connection to this app there, for the re-consent diff. */
	existing: { scopes: AgentScope[]; projectIds: string[] | null; createdAt: string } | null;
}

/** The consent screen's read. */
export type ConsentContext =
	| { state: "missing" | "malformed" | "expired" | "answered" }
	| {
			state: "ready";
			clientId: string;
			identity: AgentAppIdentity;
			/** Alethia fetched the app's identity from its own published metadata document (CIMD). */
			verified: boolean;
			/** The host the app sends the person back to once they answer. */
			redirectHost: string | null;
			requested: RequestedScopes;
			orgs: ConsentOrg[];
	  };

/** The host of the request's redirect URI, or null. */
function redirectHostOf(oauthQuery: string): string | null {
	const uri = new URLSearchParams(oauthQuery).get("redirect_uri");
	if (!uri) return null;
	try {
		return new URL(uri).host;
	} catch {
		return null;
	}
}

/** The organizations `userId` is a member of, or their personal workspace when they have none. */
async function membershipsOf(userId: string): Promise<{ id: string; name: string; role: string; personal: boolean }[]> {
	const rows = await getServiceDb()
		.select({ id: organization.id, name: organization.name, role: member.role })
		.from(member)
		.innerJoin(organization, eq(member.organizationId, organization.id))
		.where(eq(member.userId, userId));
	if (rows.length === 0) return [{ id: userId, name: "Personal", role: "owner", personal: true }];
	return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, personal: false }));
}

/** One org's half of the read, for `userId`; null when the person is not an active member there. */
async function consentOrg(
	userId: string,
	org: { id: string; name: string; role: string; personal: boolean },
	clientId: string,
	requested: readonly AgentScope[],
): Promise<ConsentOrg | null> {
	const actor = actorWithCredential(await getActiveScope(userId, org.id), "session");
	if (actor.orgId !== org.id) return null;
	const db = getServiceDb();
	const [policy, refusal, roleAllows, viewable] = await Promise.all([
		readAgentPolicy(db, org.id),
		orgConsentRefusal(db, org.id, clientId),
		scopesRoleAllows(actor),
		viewableProjectIds(actor),
	]);
	const projectRows = viewable.length
		? await db
				.select({ id: projects.id, name: projects.project_name })
				.from(projects)
				.where(and(eq(projects.org_id, org.id), inArray(projects.id, viewable)))
		: [];
	const existing = await withActorScope(actor, (tx) => existingGrant(tx, org.id, userId, clientId));
	return {
		id: org.id,
		name: org.name,
		role: org.role,
		personal: org.personal,
		refusal,
		agentsKeptOffProduction: policy.agentsMayNotApplyToProduction,
		roleAllows,
		grantable: grantableScopes(requested, roleAllows),
		projects: projectRows.sort((a, b) => a.name.localeCompare(b.name)),
		existing,
	};
}

/** The consent screen's read for the signed-in `userId` and the page's query string. */
export async function readConsentContext(userId: string, oauthQuery: string, now: Date = new Date()): Promise<ConsentContext> {
	const reading = parseConsentRequest(oauthQuery, now);
	if (!reading.ok) return { state: reading.reason };
	const { request } = reading;
	if (await consentAlreadyAnswered(request.key, now)) return { state: "answered" };
	const [client] = await getServiceDb()
		.select({ name: oauthClient.name, icon: oauthClient.icon, discovery: oauthClient.clientDiscoveryId })
		.from(oauthClient)
		.where(eq(oauthClient.clientId, request.clientId))
		.limit(1);
	const requested = partitionRequestedScopes(request.requestedScopes);
	const memberships = await membershipsOf(userId);
	const orgs = (await Promise.all(memberships.map((m) => consentOrg(userId, m, request.clientId, requested.agent)))).filter(
		(o): o is ConsentOrg => o !== null,
	);
	return {
		state: "ready",
		clientId: request.clientId,
		identity: agentAppIdentity({ clientId: request.clientId, name: client?.name ?? null, icon: client?.icon ?? null }),
		verified: !!client?.discovery,
		redirectHost: redirectHostOf(oauthQuery),
		requested,
		orgs,
	};
}
