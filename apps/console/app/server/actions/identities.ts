"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { authorize, authorizeQuiet, currentActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { isEnumMember } from "@/lib/coerce";
import { azureIdConflict, AZURE_GUID_REGEX } from "@/lib/cloud-providers/azure-ids";
import * as conn from "@/lib/cloud-providers/connections";
import { GCP_PROJECT_ID_REGEX } from "@/lib/cloud-providers/gcp-wif";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";
import { actorIdentityWhere } from "@/lib/runners/claim-identity";
import { headers } from "next/headers";
import { markFailed, markHealthy } from "@/lib/connectors/health";
import { auth } from "@/lib/auth";
import { resolveAccountId } from "@/lib/auth/accounts";
import { getOwner } from "@/lib/auth/owner";
import type { GitProvider as PublicGitProvider } from "@/lib/db/schema";

// Git provider tokens live in Better Auth's `account` table (Phase D full
// consolidation). Better Auth captures them on link and refreshes them on
// demand via getAccessToken — no dedicated provider_tokens table or manual
// refresh map anymore.

const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"] as const;

function isGitProvider(p: string): p is PublicGitProvider {
	return isEnumMember(p, GIT_PROVIDERS);
}

/**
 * Git providers the current user has linked (from Better Auth accounts). Resolves the session
 * first: listUserAccounts would refuse an anonymous caller too, but only by THROWING into the catch
 * below — a refusal that read as "nothing linked" and that no check could see (#5219).
 */
export async function getLinkedProviders(): Promise<PublicGitProvider[]> {
	if (!(await getOwner())) return [];
	try {
		const accounts = await auth.api.listUserAccounts({ headers: await headers() });
		const set = new Set<PublicGitProvider>();
		for (const a of accounts) {
			if (isGitProvider(a.providerId)) set.add(a.providerId);
		}
		return Array.from(set);
	} catch (error) {
		console.error("Unexpected error fetching linked providers:", error);
		return [];
	}
}

/**
 * A valid (auto-refreshed) access token for the current user's linked provider,
 * or null. Better Auth handles refresh transparently via getAccessToken.
 */
export async function getValidProviderToken(
	provider: PublicGitProvider,
): Promise<string | null> {
	let scope: { userId: string; orgId: string };
	try {
		const actor = await currentActor();
		scope = { userId: actor.userId, orgId: actor.orgId };
	} catch {
		return null;
	}
	try {
		// 1.7 selectors take the LOCAL account.id, not the provider id. No link → no token,
		// and that is an expected state (the user simply has not connected this provider),
		// so report it the same way a missing token is reported rather than throwing.
		const accountId = await resolveAccountId(scope.userId, provider);
		if (accountId === null) {
			void markFailed(scope, "git", provider, "no linked account for this provider");
			return null;
		}
		const res = await auth.api.getAccessToken({
			body: { accountId, userId: scope.userId },
			headers: await headers(),
		});
		const token = res.accessToken ?? null;
		// Point-of-use connector health: success clears, failure emits once (durable, no poll).
		if (token) void markHealthy(scope, "git", provider);
		else void markFailed(scope, "git", provider, "no access token returned");
		return token;
	} catch (err) {
		void markFailed(
			scope,
			"git",
			provider,
			err instanceof Error ? err.message : "token refresh failed",
		);
		return null;
	}
}

const deleteProviderTokenInput = z.object({ provider: z.enum(GIT_PROVIDERS) });

/**
 * Unlinks a git provider from the current user. Idempotent: a provider that is already unlinked
 * satisfies the request.
 */
export async function deleteProviderToken(
	raw: z.input<typeof deleteProviderTokenInput>,
): Promise<ActionResult<{ provider: PublicGitProvider }>> {
	return defineAction({ input: deleteProviderTokenInput, run: ({ input }) => runDeleteProviderToken(input) })(raw);
}

/** The body of {@link deleteProviderToken}, on already-validated input. */
async function runDeleteProviderToken(input: z.output<typeof deleteProviderTokenInput>): Promise<{ provider: PublicGitProvider }> {
	// 1.7's unlinkAccount takes the local account.id. Resolving it needs the user, which the
	// session carries — but currentActor() is the seam that already knows it.
	const actor = await currentActor();
	const accountId = await resolveAccountId(actor.userId, input.provider);
	if (accountId !== null) {
		await auth.api.unlinkAccount({ body: { accountId }, headers: await headers() });
	}
	return { provider: input.provider };
}

// ── Cloud accounts ───────────────────────────────────────────────────────────────────────────
// The connectors board's writes on cloud identities (#6124, ADR 0005 D4). Each one:
//   1. asks the PDP for `manage_identities` on the identity;
//   2. loads the identity by id through the SAME rule the board read it with — an org-shared
//      identity of the addressed org, or the caller's own personal one (`actorIdentityWhere`) — AND bound to the addressed org. An id that fails either test
//      is "not found", whatever the PDP answered;
//   3. only then calls the connection library (`lib/cloud-providers/connections.ts`).

/** Every cloud a connect flow exists for. */
const CLOUD_PROVIDERS = ["aws", "gcp", "azure", "alibaba", "digitalocean", "hetzner", "civo"] as const;

/** The clouds connected by a scoped API token. */
const TOKEN_CLOUD_PROVIDERS = ["digitalocean", "hetzner", "civo"] as const;

/** The refusal every id-addressed write gives an identity the caller cannot reach. */
const IDENTITY_NOT_FOUND = "That cloud account no longer exists in this workspace. Reload and try again.";

/**
 * The identity `identityId`, if `actor` may act on it from the org it is addressing; otherwise a
 * `not-found` refusal. The org binding (`org_id`) is stated on top of the scope rule because the
 * connection library writes by `id` + `org_id`: a personal identity the caller authored in a
 * DIFFERENT org passes the scope rule, and the library would then match no row and report success
 * having done nothing.
 */
async function manageableIdentity(actor: Actor, identityId: string) {
	const [row] = await getServiceDb()
		.select({ id: cloudIdentities.id, provider: cloudIdentities.provider })
		.from(cloudIdentities)
		.where(
			and(
				// The console's writes are a signed-in person's (a session), so the personal arm is theirs.
				actorIdentityWhere(identityId, actor.orgId, actor.userId),
				eq(cloudIdentities.org_id, actor.orgId),
			),
		)
		.limit(1);
	if (!row) throw new ActionRefusal("not-found", IDENTITY_NOT_FOUND);
	return row;
}

/** Authorizes `manage_identities` on one identity and loads it through {@link manageableIdentity}. */
async function authorizeIdentity(identityId: string) {
	const actor = await authorize("manage_identities", { type: "cloud_identity", id: identityId });
	return { actor, identity: await manageableIdentity(actor, identityId) };
}

/** A cloud identity id on the wire. */
const identityId = z.string().uuid("That is not a cloud account id.");

/** The verification outcome a connect or a re-verify returns (no credential in it). */
export interface CloudVerifyResult {
	identityId: string;
	/** True when the account authenticated (connected or degraded). */
	verified: boolean;
	status: conn.ConnectionResult["status"];
	/** Why verification failed; null when it did not. */
	error: string | null;
	/** Provisioning permissions the probe found missing (the degraded hint). */
	missingPermissions: string[];
}

/** Narrows the library's result to the fields the connect UI shows. */
function toVerifyResult(r: conn.ConnectionResult): CloudVerifyResult {
	return {
		identityId: r.identityId,
		verified: r.verified,
		status: r.status,
		error: r.error,
		missingPermissions: r.missingPermissions,
	};
}

const startCloudConnectInput = z.object({ provider: z.enum(CLOUD_PROVIDERS) });

/**
 * Starts a connect flow: the pending identity the connect sheet binds its form to. Reuses the org's
 * dangling pending row for this provider rather than piling up empties.
 */
export async function startCloudConnect(
	raw: z.input<typeof startCloudConnectInput>,
): Promise<ActionResult<{ identityId: string; externalId?: string }>> {
	return defineAction({ input: startCloudConnectInput, run: ({ input }) => runStartCloudConnect(input) })(raw);
}

/** The body of {@link startCloudConnect}, on already-validated input. */
async function runStartCloudConnect(input: z.output<typeof startCloudConnectInput>): Promise<{ identityId: string; externalId?: string }> {
	const actor = await authorizeQuiet("manage_identities", { type: "cloud_identity" });
	return conn.initIdentity(actor, input.provider);
}

const ALIBABA_ROLE_ARN = /^acs:ram::\d+:role\/[\w+=,.@-]+$/;

/** A field that must hold one Azure GUID. */
const azureGuid = (label: string) =>
	z.string().trim().regex(AZURE_GUID_REGEX, `Invalid ${label} format. Expected a UUID.`);

/**
 * What each connect form submits. Every check the connection library would refuse with is made
 * here first, so a mistyped value comes back as a field error on the form rather than as a failed
 * request — the library re-checks all of them.
 */
const connectInput = z.discriminatedUnion("method", [
	z.object({
		method: z.literal("aws"),
		identityId,
		roleArn: z.string().trim().superRefine((value, ctx) => {
			try {
				conn.parseAwsRoleArn(value);
			} catch (error) {
				ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid role ARN." });
			}
		}),
	}),
	z.object({
		method: z.literal("gcp-wif"),
		identityId,
		wifConfigJson: z.string().superRefine((value, ctx) => {
			try {
				conn.parseWifConfig(value);
			} catch (error) {
				ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid configuration." });
			}
		}),
	}),
	z.object({
		method: z.literal("gcp-ids"),
		identityId,
		projectId: z
			.string()
			.trim()
			.regex(
				GCP_PROJECT_ID_REGEX,
				"Invalid GCP project ID (6–30 chars: lowercase letters, digits, hyphens; starts with a letter).",
			),
		projectNumber: z.string().trim().regex(/^\d{1,20}$/, "Project number must be digits only."),
	}),
	z
		.object({
			method: z.literal("azure"),
			identityId,
			tenantId: azureGuid("Tenant ID"),
			clientId: azureGuid("Client ID (Application ID)"),
			subscriptionId: azureGuid("Subscription ID"),
		})
		.superRefine((ids, ctx) => {
			const conflict = azureIdConflict(ids);
			if (conflict) ctx.addIssue({ code: "custom", path: [conflict.field], message: conflict.message });
		}),
	z.object({
		method: z.literal("alibaba"),
		identityId,
		roleArn: z
			.string()
			.trim()
			.regex(ALIBABA_ROLE_ARN, "Invalid format. Expected: acs:ram::5123456789012345:role/RoleName"),
	}),
	z
		.object({
			method: z.literal("token"),
			identityId,
			provider: z.enum(TOKEN_CLOUD_PROVIDERS),
			token: z.string().trim().min(16, "Invalid API token format"),
			s3AccessKey: z.string().trim().optional(),
			s3SecretKey: z.string().trim().optional(),
		})
		.superRefine((v, ctx) => {
			if (Boolean(v.s3AccessKey) !== Boolean(v.s3SecretKey)) {
				ctx.addIssue({
					code: "custom",
					path: [v.s3AccessKey ? "s3SecretKey" : "s3AccessKey"],
					message: "Provide both the Hetzner S3 access key and secret key, or neither.",
				});
			}
		}),
]);

/** The cloud each connect method writes. */
function providerOf(input: z.output<typeof connectInput>): conn.CloudProvider {
	switch (input.method) {
		case "aws":
			return "aws";
		case "gcp-wif":
		case "gcp-ids":
			return "gcp";
		case "azure":
			return "azure";
		case "alibaba":
			return "alibaba";
		case "token":
			return input.provider;
	}
}

const connectCloudAccountInput = connectInput;

/**
 * Saves a cloud account's connection and verifies it server-side in the same request (no runner, no
 * job). An account that does not authenticate is a SUCCESSFUL result with `verified: false` and the
 * provider's reason — the connect sheet shows it in place, next to the form; a refusal (no
 * permission, an id this workspace cannot reach, a malformed value) is the typed error instead.
 */
export async function connectCloudAccount(
	raw: z.input<typeof connectCloudAccountInput>,
): Promise<ActionResult<CloudVerifyResult>> {
	return defineAction({ input: connectCloudAccountInput, run: ({ input }) => runConnectCloudAccount(input) })(raw);
}

/** The body of {@link connectCloudAccount}, on already-validated input. */
async function runConnectCloudAccount(input: z.output<typeof connectCloudAccountInput>): Promise<CloudVerifyResult> {
	const { actor, identity } = await authorizeIdentity(input.identityId);
	const provider = providerOf(input);
	if (identity.provider !== provider) {
		throw new ActionRefusal("conflict", "That connect session belongs to a different cloud. Close the sheet and start again.");
	}
	switch (input.method) {
		case "aws":
			return toVerifyResult(await conn.saveAwsIdentity(actor, identity.id, input.roleArn));
		case "gcp-wif":
			return toVerifyResult(await conn.saveGcpIdentity(actor, identity.id, input.wifConfigJson));
		case "gcp-ids":
			return toVerifyResult(
				await conn.saveGcpIdentityFromIds(actor, identity.id, input.projectId, input.projectNumber),
			);
		case "azure":
			return toVerifyResult(
				await conn.saveAzureIdentity(actor, identity.id, input.tenantId, input.clientId, input.subscriptionId),
			);
		case "alibaba":
			return toVerifyResult(await conn.saveAlibabaIdentity(actor, identity.id, input.roleArn));
		case "token":
			return toVerifyResult(
				await conn.saveTokenCloudIdentity(
					actor,
					identity.id,
					input.provider,
					input.token,
					input.s3AccessKey || undefined,
					input.s3SecretKey || undefined,
				),
			);
	}
}

const verifyCloudAccountInput = z.object({ identityId });

/** Re-verifies a saved cloud account with its stored configuration (no re-entry). */
export async function verifyCloudAccount(
	raw: z.input<typeof verifyCloudAccountInput>,
): Promise<ActionResult<CloudVerifyResult>> {
	return defineAction({ input: verifyCloudAccountInput, run: ({ input }) => runVerifyCloudAccount(input) })(raw);
}

/** The body of {@link verifyCloudAccount}, on already-validated input. */
async function runVerifyCloudAccount(input: z.output<typeof verifyCloudAccountInput>): Promise<CloudVerifyResult> {
	const { actor, identity } = await authorizeIdentity(input.identityId);
	return toVerifyResult(await conn.reverifyConnection(actor, identity.id));
}

const renameCloudAccountInput = z.object({
		identityId,
		name: z.string().trim().min(1, "Name cannot be empty.").max(120, "Keep the name under 120 characters."),
	});

/** Renames a cloud account. */
export async function renameCloudAccount(
	raw: z.input<typeof renameCloudAccountInput>,
): Promise<ActionResult<{ identityId: string; name: string }>> {
	return defineAction({ input: renameCloudAccountInput, run: ({ input }) => runRenameCloudAccount(input) })(raw);
}

/** The body of {@link renameCloudAccount}, on already-validated input. */
async function runRenameCloudAccount(input: z.output<typeof renameCloudAccountInput>): Promise<{ identityId: string; name: string }> {
	const { actor, identity } = await authorizeIdentity(input.identityId);
	await conn.renameIdentity(actor, identity.id, input.name);
	return { identityId: identity.id, name: input.name };
}

const disconnectCloudAccountInput = z.object({ identityId });

/**
 * Disconnects a cloud account: clears its stored configuration, unbinds the org's projects from it
 * and purges its inventory. The provider is the stored row's, not the client's.
 */
export async function disconnectCloudAccount(
	raw: z.input<typeof disconnectCloudAccountInput>,
): Promise<ActionResult<{ identityId: string }>> {
	return defineAction({ input: disconnectCloudAccountInput, run: ({ input }) => runDisconnectCloudAccount(input) })(raw);
}

/** The body of {@link disconnectCloudAccount}, on already-validated input. */
async function runDisconnectCloudAccount(input: z.output<typeof disconnectCloudAccountInput>): Promise<{ identityId: string }> {
	const { actor, identity } = await authorizeIdentity(input.identityId);
	if (!isEnumMember(identity.provider, CLOUD_PROVIDERS)) {
		throw new ActionRefusal("conflict", "This cloud account cannot be disconnected from here.");
	}
	await conn.disconnectIdentity(actor, identity.id, identity.provider);
	return { identityId: identity.id };
}
