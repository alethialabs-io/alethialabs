"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb, withScope } from "@/lib/db";
import {
	cloudIdentities,
	type Connector,
	connectorCredentials,
	connectors as connectorsTable,
} from "@/lib/db/schema";
import type { CredentialScope } from "@/lib/db/schema/enums";
import { encryptSecret } from "@/lib/crypto/secrets";
import { getConnectorProviderBySlug } from "@/lib/connectors/registry.generated";
import { verifyConnectorCredential as pingConnector } from "@/lib/connectors/verify";
import type { ConnectorCredentials } from "@/types/jsonb.types";

export type ConnectorCategory = Connector["category"];
export type ConnectorAuthMethod = Connector["auth_method"];
export type ConnectorStatus = Connector["status"];

export type ConnectorConnectionDetails = {
	username?: string;
	avatar_url?: string;
	identity_id?: string;
	account_id?: string;
	role_arn?: string;
	project_id?: string;
	service_account_email?: string;
	tenant_id?: string;
	subscription_id?: string;
	cloud_identity_id?: string;
};

export type GitTokenHealth = "healthy" | "expired" | "refresh_failed";

/**
 * The presentation groups the connectors page renders. Each maps 1:1 to a connector category so the
 * page reflects what a connector actually IS (a credential to an external system we act through), with
 * no `apps` catch-all lumping git/observability/dns together. (`chart_repos` is the `helm_registry`
 * category — private OCI/HTTPS chart-repo credentials.)
 */
export type ConnectorGroup =
	| "clouds"
	| "source"
	| "registries"
	| "chart_repos"
	| "secrets"
	| "observability"
	| "dns";

/** The health of one cloud account, mirroring `cloud_identities.status`. */
export type CloudAccountStatus = "connected" | "degraded" | "testing" | "failed";

/**
 * One configured cloud account (a cloud_identity row a credential was actually submitted for —
 * verified or not). Broken accounts are included deliberately: an unverified identity used to be
 * invisible here, which left it with no disconnect affordance anywhere in the UI and no way to
 * remove a connection whose credentials were wrong.
 */
export type CloudAccount = {
	identityId: string;
	name: string;
	/** Short descriptor — account id / project / subscription. */
	label?: string;
	status: CloudAccountStatus;
	/** Provisioning permissions the probe found MISSING (what makes an account `degraded`). */
	missingPermissions?: string[];
	/** Why verification failed (set when `status === "failed"`). */
	lastError?: string;
};

export type ConnectorWithConnection = Connector & {
	connected: boolean;
	connection_details: ConnectorConnectionDetails | null;
	token_health?: GitTokenHealth;
	/** Visibility of the backing credential (cloud / api_key). Undefined for git. */
	scope?: CredentialScope;
	/** The connector_credential row id for a connected api_key connector — the
	 *  classifiable `connector_credential` resource. Undefined for cloud/git. */
	credential_id?: string;
	/** The presentation group (clouds / source / registries / secrets / observability / dns). */
	group: ConnectorGroup;
	/** Configured accounts for cloud connectors — a provider can hold several, and a broken one is
	 *  listed too (with its status) so it can be re-verified or removed. */
	accounts?: CloudAccount[];
	/**
	 * The connector-level rollup shown on the card/row. `degraded` means at least one account
	 * authenticated but is missing provisioning permissions — it is NOT a synonym for disconnected,
	 * so the connector still reads as connected.
	 */
	cloud_health?: "testing" | "failed" | "degraded";
	/** The last verification error (set when `cloud_health === "failed"`). */
	last_error?: string;
	/** Provisioning permissions missing across the connector's accounts (drives `degraded`). */
	missing_permissions?: string[];
	/** The cloud identity to re-verify (for a failed/testing/degraded cloud connector). */
	reverify_identity_id?: string;
};

/** What saving an api_key credential tells the connect form. */
export interface ConnectorCredentialSaved {
	/** Whether the provider accepted the credential when it was pinged. */
	verified: boolean;
	/** The provider's own words when it did not (or a note when it did). */
	message?: string;
}

/** The catalog row id for `slug`, or a `not-found` refusal. */
async function catalogConnectorId(slug: string): Promise<string> {
	const [connector] = await getServiceDb()
		.select({ id: connectorsTable.id })
		.from(connectorsTable)
		.where(eq(connectorsTable.slug, slug))
		.limit(1);
	if (!connector) throw new ActionRefusal("not-found", `Connector not in catalog: ${slug}`);
	return connector.id;
}

/**
 * The api_key connect form's input: the connector and its fields. Each field the provider's
 * registry entry marks required must be filled — reported per field (`fields.<key>`), so the form
 * shows it under the input.
 */
const saveCredentialInput = z
	.object({ slug: z.string().min(1), fields: z.record(z.string(), z.string()) })
	.superRefine(({ slug, fields }, ctx) => {
		const provider = getConnectorProviderBySlug(slug);
		if (!provider) {
			ctx.addIssue({ code: "custom", path: ["slug"], message: `Unknown connector: ${slug}` });
			return;
		}
		for (const f of provider.credentialFields) {
			if (f.required && !fields[f.key]?.trim()) {
				ctx.addIssue({ code: "custom", path: ["fields", f.key], message: `${f.label} is required.` });
			}
		}
	});

const saveConnectorCredentialInput = saveCredentialInput;

/**
 * Splits submitted fields into non-secret (plaintext) + secret (encrypted) groups per the provider's
 * registry credential project, builds the stored envelope, pings the provider to verify, and upserts
 * the connector_credentials row. An unverified credential is still saved — `verified: false` says so.
 */
export async function saveConnectorCredential(
	raw: z.input<typeof saveConnectorCredentialInput>,
): Promise<ActionResult<ConnectorCredentialSaved>> {
	return defineAction({ input: saveConnectorCredentialInput, run: ({ input }) => runSaveConnectorCredential(input) })(raw);
}

/** The body of {@link saveConnectorCredential}, on already-validated input. */
async function runSaveConnectorCredential(input: z.output<typeof saveConnectorCredentialInput>): Promise<ConnectorCredentialSaved> {
	const actor = await authorize("manage_connectors", { type: "connector" });
	const provider = getConnectorProviderBySlug(input.slug);
	if (!provider) throw new ActionRefusal("not-found", `Unknown connector: ${input.slug}`);
	const connectorId = await catalogConnectorId(input.slug);

	// Partition into non-secret (stored plaintext) and secret (AEAD-encrypted).
	const plain: Record<string, string> = {};
	const secret: Record<string, string> = {};
	for (const f of provider.credentialFields) {
		const value = input.fields[f.key];
		if (value === undefined || value === "") continue;
		if (f.secret) secret[f.key] = value;
		else plain[f.key] = value;
	}

	// Verify against the live provider with the full field set.
	const verdict = await pingConnector(input.slug, input.fields);

	const credentials: ConnectorCredentials = {
		fields: plain,
		secret: Object.keys(secret).length ? encryptSecret(secret) : null,
	};

	// Connectors are org-scoped: a saved credential is shared with the whole org (subject to the
	// manage_connectors permission, enforced above). The conflict target is the org partial-unique
	// index, so the targetWhere mirrors its predicate.
	await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
		tx
			.insert(connectorCredentials)
			.values({
				user_id: actor.userId,
				org_id: actor.orgId,
				connector_id: connectorId,
				scope: "org",
				credentials,
				is_verified: verdict.ok,
			})
			.onConflictDoUpdate({
				target: [connectorCredentials.org_id, connectorCredentials.connector_id],
				targetWhere: sql`scope = 'org'`,
				set: { credentials, is_verified: verdict.ok, updated_at: new Date() },
			}),
	);

	return { verified: verdict.ok, message: verdict.message };
}

const deleteConnectorCredentialInput = z.object({ slug: z.string().min(1) });

/** Removes the stored api_key credential for a connector. */
export async function deleteConnectorCredential(
	raw: z.input<typeof deleteConnectorCredentialInput>,
): Promise<ActionResult<{ slug: string }>> {
	return defineAction({ input: deleteConnectorCredentialInput, run: ({ input }) => runDeleteConnectorCredential(input) })(raw);
}

/** The body of {@link deleteConnectorCredential}, on already-validated input. */
async function runDeleteConnectorCredential(input: z.output<typeof deleteConnectorCredentialInput>): Promise<{ slug: string }> {
	const actor = await authorize("manage_connectors", { type: "connector" });
	const connectorId = await catalogConnectorId(input.slug);
	// Tenancy is enforced by withScope + RLS (scoped_all); filter by the resource key only — an
	// explicit org_id predicate is redundant and trips check:authz-scope.
	await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
		tx.delete(connectorCredentials).where(eq(connectorCredentials.connector_id, connectorId)),
	);
	return { slug: input.slug };
}

/**
 * Shares an api_key connector credential with the whole org (scope='org') or pulls it
 * back to personal. Managing org credentials is a PDP `manage_connectors` action — so
 * it also flows through the activity/alert chokepoint. Promotes the caller's personal row;
 * demotes the org row back to its author.
 */
export async function setConnectorCredentialScope(
	slug: string,
	scope: CredentialScope,
): Promise<{ ok: boolean; error?: string }> {
	const actor = await authorize("manage_connectors", { type: "connector" });
	const db = getServiceDb();

	const [connector] = await db
		.select({ id: connectorsTable.id })
		.from(connectorsTable)
		.where(eq(connectorsTable.slug, slug))
		.limit(1);
	if (!connector) return { ok: false, error: `Connector not in catalog: ${slug}` };

	try {
		const updated =
			scope === "org"
				? await db
						.update(connectorCredentials)
						.set({ scope: "org", org_id: actor.orgId, updated_at: new Date() })
						.where(
							and(
								eq(connectorCredentials.connector_id, connector.id),
								eq(connectorCredentials.user_id, actor.userId), // authz-scope-ok: actor's own personal credential (personal→org promotion)
								eq(connectorCredentials.scope, "personal"),
							),
						)
						.returning({ id: connectorCredentials.id })
				: await db
						.update(connectorCredentials)
						// Back to personal: org_id follows the author so personal RLS holds.
						.set({
							scope: "personal",
							org_id: sql`user_id`,
							updated_at: new Date(),
						})
						.where(
							and(
								eq(connectorCredentials.connector_id, connector.id),
								eq(connectorCredentials.org_id, actor.orgId),
								eq(connectorCredentials.scope, "org"),
							),
						)
						.returning({ id: connectorCredentials.id });

		if (updated.length === 0) {
			return {
				ok: false,
				error:
					scope === "org"
						? "No personal credential to share."
						: "No shared credential to make personal.",
			};
		}
		return { ok: true };
	} catch {
		return {
			ok: false,
			error: `An ${scope === "org" ? "org" : "personal"} credential already exists for this connector.`,
		};
	}
}

/**
 * Shares a cloud identity with the org (scope='org') or pulls it back to personal.
 * Guarded by the PDP `manage_identities` action.
 */
export async function setCloudIdentityScope(
	identityId: string,
	scope: CredentialScope,
): Promise<{ ok: boolean; error?: string }> {
	const actor = await authorize("manage_identities", {
		type: "cloud_identity",
		id: identityId,
	});
	const db = getServiceDb();

	try {
		const updated =
			scope === "org"
				? await db
						.update(cloudIdentities)
						.set({ scope: "org", org_id: actor.orgId, updated_at: new Date() })
						.where(
							and(
								eq(cloudIdentities.id, identityId),
								eq(cloudIdentities.user_id, actor.userId), // authz-scope-ok: actor's own personal cloud identity (personal→org promotion)
								eq(cloudIdentities.scope, "personal"),
							),
						)
						.returning({ id: cloudIdentities.id })
				: await db
						.update(cloudIdentities)
						.set({
							scope: "personal",
							org_id: sql`user_id`,
							updated_at: new Date(),
						})
						.where(
							and(
								eq(cloudIdentities.id, identityId),
								eq(cloudIdentities.org_id, actor.orgId),
								eq(cloudIdentities.scope, "org"),
							),
						)
						.returning({ id: cloudIdentities.id });

		if (updated.length === 0) {
			return { ok: false, error: "Cloud identity not found for this action." };
		}
		return { ok: true };
	} catch {
		return { ok: false, error: "Could not change the credential's scope." };
	}
}
