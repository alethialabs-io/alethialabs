"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Answering the consent screen (AGT-L2, gaps G8 and G17). The page sends the signed request it was
// opened with and the person's choices; this action checks the choices against what the org and the
// person's role allow, hands the answer to Better Auth's consent endpoint (which verifies the request's
// signature and records the consent), then writes the grant — org, scopes, projects — for that
// consent. Only then is the redirect back to the app returned, so an app never receives a code for a
// consent whose grant was not written.
//
// The consent and its grant are recorded together or not at all. Better Auth writes its consent row
// through its own adapter, outside any transaction of ours, so the two cannot share one; instead the
// person's consent rows for the client are read first and put back as they were (lib/agents/consent.ts,
// `restoreConsent`) whenever the grant is not written. A consent left without a grant would let the
// next authorization skip the consent screen; the MCP route refuses such a token as well
// (lib/agents/grant-binding.ts), so this is the first of two independent checks.
//
// An expired request and one already answered come back as their own outcomes (not refusals), so the
// page can say which happened.

import { headers } from "next/headers";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { agentAppIdentity } from "@/lib/agents/catalog";
import {
	type ConsentSnapshot,
	consentAlreadyAnswered,
	consentRedirectUrl,
	grantableProjectIds,
	grantableScopes,
	markConsentAnswered,
	orgConsentRefusal,
	parseConsentRequest,
	partitionRequestedScopes,
	readConsentSnapshot,
	restoreConsent,
	scopesRoleAllows,
	writeGrantForConsent,
} from "@/lib/agents/consent";
import { AGENT_SCOPES } from "@/lib/approvals/types";
import { auth } from "@/lib/auth";
import { UnauthorizedError } from "@/lib/auth/errors";
import { recordActivity } from "@/lib/authz/activity";
import { authorizeInOrg } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { viewableProjectIds } from "@/lib/jobs/visibility";
import { log } from "@/lib/observability/log";

const answerInput = z.object({
	/** The consent page's query string, as Better Auth signed it. */
	oauthQuery: z.string().min(1).max(8000),
	accept: z.boolean(),
	/** The org to connect the app in. Required to allow. */
	orgId: z.uuid().optional(),
	/** The agent scopes the person ticked. Required (non-empty) to allow. */
	scopes: z.array(z.enum(AGENT_SCOPES)).max(AGENT_SCOPES.length).optional(),
	/** The projects chosen, or null for every project in the org. */
	projectIds: z.array(z.uuid()).min(1).max(500).nullish(),
});

/** How the answer went. Only `redirect` carries somewhere to go. */
export type ConsentAnswer =
	| { outcome: "redirect"; url: string }
	| { outcome: "expired" }
	| { outcome: "answered" }
	| { outcome: "invalid" };

/** The refusal sentences, in the consent screen's wording (SPEC §5b). */
const REFUSALS = {
	agent_access_disabled: "Agents are turned off in this organization. Choose another organization, or ask someone who manages agents there.",
	client_not_allowed: "This organization only lets approved apps act as agents. Choose another organization, or ask someone who manages agents to add this app.",
	no_scope: "Choose at least one permission, or deny.",
	scope_not_offered: "One of the chosen permissions isn't one your role can grant here.",
	no_org: "Choose an organization.",
	project_not_allowed: "One of the chosen projects isn't one you can use in this organization.",
} as const;

/**
 * Better Auth's consent endpoint, called in-process through its own handler with the person's
 * request headers (their session cookie and origin), exactly as the browser would call it — so the
 * provider's signature check runs. Returns the redirect it answers with, or null when it refused.
 */
async function callConsentEndpoint(body: { accept: boolean; scope?: string; oauth_query: string }): Promise<string | null> {
	const base = auth.options.baseURL;
	if (typeof base !== "string") return null;
	const requestHeaders = new Headers(await headers());
	requestHeaders.set("content-type", "application/json");
	requestHeaders.set("accept", "application/json");
	requestHeaders.delete("content-length");
	const response = await auth.handler(
		new Request(new URL("/api/auth/oauth2/consent", base), {
			method: "POST",
			headers: requestHeaders,
			body: JSON.stringify(body),
		}),
	);
	// Better Auth answers a bad signature and a lapsed request with one error. The expiry was already
	// checked from the signed `exp`, so a refusal here means the request did not verify.
	if (!response.ok) return null;
	return consentRedirectUrl(await response.json().catch(() => null));
}

/**
 * Puts the person's consent rows back as `before` recorded them, after an answer whose grant was not
 * written. A failure here is reported and swallowed so the caller's own outcome still reaches the
 * page; the MCP route refuses a token whose consent has no grant, so a leftover row grants nothing.
 */
async function putConsentBack(before: ConsentSnapshot): Promise<void> {
	try {
		await restoreConsent(before);
	} catch (error) {
		log.error("[agents] could not put an agent consent back after its grant was not written", { err: error });
	}
}

/** Answers the consent request for the signed-in person. */
export async function answerAgentConsent(raw: z.input<typeof answerInput>): Promise<ActionResult<ConsentAnswer>> {
	return defineAction({
		input: answerInput,
		run: async ({ input }): Promise<ConsentAnswer> => {
			const session = await auth.api.getSession({ headers: await headers() });
			if (!session?.user) throw new UnauthorizedError();
			const userId = session.user.id;

			const reading = parseConsentRequest(input.oauthQuery);
			if (!reading.ok) return { outcome: reading.reason === "expired" ? "expired" : "invalid" };
			const { request } = reading;
			if (await consentAlreadyAnswered(request.key)) return { outcome: "answered" };

			if (!input.accept) {
				const url = await callConsentEndpoint({ accept: false, oauth_query: input.oauthQuery });
				if (!url) return { outcome: "invalid" };
				await markConsentAnswered(request.key, "denied", request.expiresAt);
				return { outcome: "redirect", url };
			}

			if (!input.orgId) throw new ActionRefusal("conflict", REFUSALS.no_org);
			const actor = await authorizeInOrg("view", { type: "org" }, input.orgId);
			const refusal = await withActorScope(actor, (tx) => orgConsentRefusal(tx, actor.orgId, request.clientId));
			if (refusal) throw new ActionRefusal("conflict", REFUSALS[refusal]);

			const requested = partitionRequestedScopes(request.requestedScopes);
			const grantable = grantableScopes(requested.agent, await scopesRoleAllows(actor));
			const chosen = [...new Set(input.scopes ?? [])];
			if (chosen.length === 0) throw new ActionRefusal("conflict", REFUSALS.no_scope);
			if (chosen.some((s) => !grantable.includes(s))) throw new ActionRefusal("conflict", REFUSALS.scope_not_offered);

			let projectIds: string[] | null = null;
			if (input.projectIds) {
				const wanted = [...new Set(input.projectIds)];
				const allowed = await grantableProjectIds(actor.orgId, wanted, await viewableProjectIds(actor));
				if (allowed.length !== wanted.length) throw new ActionRefusal("conflict", REFUSALS.project_not_allowed);
				projectIds = allowed;
			}

			// Only scopes the client asked for reach Better Auth (it refuses any other), and unknown ones
			// are dropped: the sign-in scopes it requested, plus the agent scopes the person ticked.
			const scope = [...requested.oidc, ...chosen].join(" ");
			const before = await readConsentSnapshot(request.clientId, userId);
			const url = await callConsentEndpoint({ accept: true, scope, oauth_query: input.oauthQuery });
			if (!url) {
				// Better Auth may have recorded the consent and then answered in a shape with no URL in it.
				await putConsentBack(before);
				return { outcome: "invalid" };
			}

			let grantId: string | null;
			try {
				grantId = await withActorScope(actor, (tx) =>
					writeGrantForConsent(tx, { orgId: actor.orgId, userId, clientId: request.clientId, scopes: chosen, projectIds }),
				);
			} catch (error) {
				await putConsentBack(before);
				throw error;
			}
			if (!grantId) {
				await putConsentBack(before);
				throw new Error("the consent was recorded without a consent row to bind the grant to");
			}
			await markConsentAnswered(request.key, "allowed", request.expiresAt);

			const identity = agentAppIdentity({ clientId: request.clientId, name: null, icon: null });
			recordActivity(actor, "connect_agent", { type: "agent_grant", id: grantId }, {
				resourceName: identity.name,
				reason: `${chosen.join(", ")} · ${projectIds ? `${projectIds.length} project(s)` : "all projects"}`,
			});
			return { outcome: "redirect", url };
		},
	})(raw);
}
