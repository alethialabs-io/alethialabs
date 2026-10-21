// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { asc, desc, eq, isNotNull } from "drizzle-orm";
import type {
	CloudAccount,
	CloudAccountStatus,
	ConnectorCategory,
	ConnectorGroup,
	ConnectorWithConnection,
	GitTokenHealth,
} from "@/app/server/actions/connectors";
import { getValidProviderToken } from "@/app/server/actions/identities";
import { getPdp } from "@/lib/authz";
import { currentActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { identityWasConfigured } from "@/lib/cloud-providers/identity-configured";
import { computePlatformConfigured } from "@/lib/connectors/cloud-connect-setup";
import { asGitProvider } from "@/lib/connectors/git-providers";
import { getServiceDb, withScope } from "@/lib/db";
import {
	account,
	cloudIdentities,
	connectorCredentials,
	connectors as connectorsTable,
} from "@/lib/db/schema";
import { query } from "@/lib/rpc/base";

/** Maps a catalog category to its presentation group on the connectors page (1:1, exhaustive). */
function groupForCategory(category: ConnectorCategory): ConnectorGroup {
	switch (category) {
		case "cloud":
			return "clouds";
		case "git":
			return "source";
		case "registry":
			return "registries";
		case "helm_registry":
			return "chart_repos";
		case "secrets":
			return "secrets";
		case "observability":
			return "observability";
		case "dns":
			return "dns";
		default: {
			// Exhaustiveness guard: a new connector_category must add its group here — otherwise this
			// fails to compile rather than silently falling through.
			const _exhaustive: never = category;
			return _exhaustive;
		}
	}
}

/** Maps a `cloud_identities.status` onto the account status the UI renders. */
function accountStatus(status: string): CloudAccountStatus {
	switch (status) {
		case "connected":
			return "connected";
		case "degraded":
			return "degraded";
		case "testing":
			return "testing";
		// `disconnected` (access lost) and `failed` both present as a failed verification the user
		// can retry or remove. `pending` only reaches here for a configured row mid-resubmit.
		default:
			return "failed";
	}
}

/**
 * The connector catalog with `actor`'s connection status per connector — the body that used to be
 * the `getConnectorsWithStatus` server action (ADR 0005 D1, #6124).
 *
 * `actor === null` reads the catalog with nothing connected: the callers that resolve an actor
 * best-effort (the mention picker, the agent's tool) keep the behaviour they had. The board passes
 * the actor its entry point resolved, so a failed resolution is a refusal there, never an empty
 * board.
 *
 * WHAT TRAVELS. The catalog row, a health rollup, and per cloud account its name, a short label
 * (account / project / subscription id), its status, missing permissions and last error. Stored
 * credentials are read here only to decide whether an identity was ever configured and to build
 * the label; no secret field, token or encrypted envelope is placed in the result, and no git token
 * value is selected at all.
 *
 * WHICH IDENTITIES. The `scoped_all` RLS policy decides (`withScope`): the org-shared identities
 * of the actor's org plus the caller's own personal ones — the rule this read had as a server
 * action, unchanged by the move.
 */
async function readConnectorsFor(actor: Actor | null): Promise<ConnectorWithConnection[]> {
	// Public catalog — service connection (no owner scope).
	const catalog = await getServiceDb()
		.select()
		.from(connectorsTable)
		.orderBy(asc(connectorsTable.sort_order));

	// Git provider links live in Better Auth's `account` table (service-managed, keyed by the
	// actor's user). Only the expiry and WHETHER a refresh token exists are read.
	const tokenRows = actor
		? await getServiceDb()
				.select({
					provider: account.providerId,
					expires_at: account.accessTokenExpiresAt,
					refreshable: isNotNull(account.refreshToken),
				})
				.from(account)
				.where(eq(account.userId, actor.userId))
		: [];

	// EVERY cloud identity — verified or not. A broken account must still reach the UI: it is the only
	// thing that can carry a Re-verify or a Remove affordance. Newest first so the primary account
	// per provider is the latest one.
	const cloudIdentityRows = actor
		? await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
				tx
					.select({
						id: cloudIdentities.id,
						name: cloudIdentities.name,
						provider: cloudIdentities.provider,
						credentials: cloudIdentities.credentials,
						scope: cloudIdentities.scope,
						status: cloudIdentities.status,
						last_error: cloudIdentities.last_error,
						missing_permissions: cloudIdentities.missing_permissions,
					})
					.from(cloudIdentities)
					.orderBy(desc(cloudIdentities.updated_at)),
			)
		: [];

	// Skip never-configured placeholders: a pending identity pre-created for the connect sheet is
	// not an account until a credential was submitted for it.
	const configuredCloudRows = cloudIdentityRows.filter((r) =>
		identityWasConfigured(r.provider, r.credentials),
	);

	// api_key connector credentials, keyed by connector slug. Only `is_verified` and the scope are
	// read; the credential envelope is not selected. RLS returns the member's personal creds + the
	// org's shared creds.
	const credentialRows = actor
		? await withScope({ ownerId: actor.userId, orgId: actor.orgId }, (tx) =>
				tx
					.select({
						id: connectorCredentials.id,
						slug: connectorsTable.slug,
						is_verified: connectorCredentials.is_verified,
						scope: connectorCredentials.scope,
					})
					.from(connectorCredentials)
					.innerJoin(connectorsTable, eq(connectorsTable.id, connectorCredentials.connector_id)),
			)
		: [];
	const credentialBySlug = new Map(
		credentialRows.map((c) => [c.slug, { id: c.id, verified: c.is_verified ?? false, scope: c.scope }]),
	);

	const tokens = new Set<string>(tokenRows.map((t) => t.provider));
	const tokenHealth = new Map<string, GitTokenHealth>();
	for (const t of tokenRows) {
		if (!t.expires_at || new Date(t.expires_at) > new Date()) {
			tokenHealth.set(t.provider, "healthy");
		} else if (t.refreshable) {
			tokenHealth.set(t.provider, "expired");
		} else {
			tokenHealth.set(t.provider, "refresh_failed");
		}
	}

	/** Builds the short account descriptor shown on a cloud account row. */
	const accountLabel = (creds: (typeof cloudIdentityRows)[number]["credentials"]) =>
		creds?.account_id ?? creds?.project_id ?? creds?.subscription_id ?? undefined;

	return catalog.map((connector): ConnectorWithConnection => {
		const slug = connector.slug;
		const group = groupForCategory(connector.category);

		if (connector.category === "git") {
			const connected = tokens.has(slug);
			return {
				...connector,
				group,
				connected,
				connection_details: null,
				token_health: connected ? tokenHealth.get(slug) : undefined,
			};
		}

		if (connector.category === "cloud") {
			// A provider can hold several accounts — collect them all, broken ones included so each
			// can carry its own Re-verify / Remove.
			const rows = configuredCloudRows.filter((ci) => ci.provider === slug);
			if (rows.length === 0) {
				return { ...connector, group, connected: false, accounts: [], connection_details: null };
			}

			const accounts: CloudAccount[] = rows.map((ci) => ({
				identityId: ci.id,
				name: ci.name,
				label: accountLabel(ci.credentials),
				status: accountStatus(ci.status),
				missingPermissions: ci.missing_permissions ?? undefined,
				lastError: ci.last_error ?? undefined,
			}));

			// A `degraded` account authenticated fine — it just can't see everything we provision into.
			// It still counts as connected; the missing permissions ride along as a warning.
			const live = accounts.filter((a) => a.status === "connected" || a.status === "degraded");
			const connected = live.length > 0;
			const primary = rows.find((r) => r.id === live[0]?.identityId) ?? rows[0];
			const creds = primary.credentials;

			// Degraded outranks a clean connect (there's something to fix); a failed account only
			// headlines when NOTHING is connected, so one broken account alongside a healthy one doesn't
			// cry wolf — it surfaces on its own row in the sheet.
			const degraded = accounts.filter((a) => a.status === "degraded");
			const broken = accounts.filter((a) => a.status === "failed");
			const testing = accounts.filter((a) => a.status === "testing");
			const cloud_health: ConnectorWithConnection["cloud_health"] = degraded.length
				? "degraded"
				: connected
					? undefined
					: broken.length
						? "failed"
						: testing.length
							? "testing"
							: undefined;

			// Whichever account the card's action should act on: the thing that needs attention.
			const needsAttention = degraded[0] ?? broken[0] ?? testing[0];

			return {
				...connector,
				group,
				connected,
				scope: primary.scope,
				accounts,
				cloud_health,
				last_error: cloud_health === "failed" ? broken[0]?.lastError : undefined,
				missing_permissions: degraded.length
					? [...new Set(degraded.flatMap((a) => a.missingPermissions ?? []))]
					: undefined,
				reverify_identity_id: needsAttention?.identityId,
				// Public identifiers only (an account id, a role ARN, a project / tenant / subscription
				// id, a service account email) — what the manage sheet shows. Named one by one so a new
				// credential field never travels by default.
				connection_details: connected
					? {
							account_id: creds?.account_id ?? undefined,
							role_arn: creds?.role_arn ?? undefined,
							project_id: creds?.project_id ?? undefined,
							service_account_email: creds?.service_account_email ?? undefined,
							tenant_id: creds?.tenant_id ?? undefined,
							subscription_id: creds?.subscription_id ?? undefined,
							cloud_identity_id: primary.id,
						}
					: null,
			};
		}

		// api_key pluggable providers (dns/secrets/registry/observability).
		const cred = connector.auth_method === "api_key" ? credentialBySlug.get(slug) : undefined;
		if (cred) {
			return {
				...connector,
				group,
				connected: true,
				scope: cred.scope,
				credential_id: cred.id,
				connection_details: null,
				token_health: cred.verified ? "healthy" : "refresh_failed",
			};
		}

		return { ...connector, group, connected: false, connection_details: null };
	});
}

/**
 * {@link readConnectorsFor} for a server caller that resolves its actor best-effort (the mention
 * picker, the agent's read tool, the create-project setup, the architecture page): with no
 * resolvable actor it reads the catalog with nothing connected, as `getConnectorsWithStatus` did.
 */
export async function readConnectorsWithStatus(): Promise<ConnectorWithConnection[]> {
	const actor = await currentActor().catch(() => null);
	return readConnectorsFor(actor);
}

/**
 * The cloud provider slugs the current tenant has a live connection for — at least one connected or
 * degraded account. Drives the overview's provider logos (full colour when connected).
 */
export async function readConnectedCloudProviders(): Promise<string[]> {
	const connectors = await readConnectorsWithStatus();
	return connectors.filter((c) => c.category === "cloud" && c.connected).map((c) => c.slug);
}

/** What the connectors board renders, in one read. */
export interface ConnectorsBoard {
	/** The catalog with the actor's connection status per connector. */
	integrations: ConnectorWithConnection[];
	/** Whether the actor may add, re-verify, rename or remove connections. */
	canManage: boolean;
	/** Per slug: does this instance have what the provider's connect flow needs. */
	platformConfigured: Record<string, boolean>;
}

/** Whether `actor` may add/edit connections (clouds + api_key connectors). */
async function readCanManage(actor: Actor): Promise<boolean> {
	const [ids, conns] = await Promise.all([
		getPdp().can(actor, "manage_identities", { type: "cloud_identity" }),
		getPdp().can(actor, "manage_connectors", { type: "connector" }),
	]);
	return ids.allowed || conns.allowed;
}

/**
 * The connectors board's read (#6124): the catalog with live status, the manage capability and the
 * instance's per-provider availability.
 *
 * NO ROW IS CREATED BY THIS READ. The page used to pre-create a pending cloud identity per
 * unconnected provider while it rendered; the connect sheet now starts its own when it opens
 * (`startCloudConnect`, a server action).
 *
 * An expired git link that can be refreshed is refreshed before the status is read, so the board
 * does not say "expired" about a link its next use renews anyway — the same refresh-on-read the
 * page did before it moved here.
 */
export async function readConnectorsBoard(actor: Actor): Promise<ConnectorsBoard> {
	const [first, canManage] = await Promise.all([readConnectorsFor(actor), readCanManage(actor)]);
	let integrations = first;
	const expired = integrations.filter((i) => i.category === "git" && i.token_health === "expired");
	if (expired.length > 0) {
		await Promise.all(
			expired.map((i) => getValidProviderToken(asGitProvider(i.slug)).catch(() => null)),
		);
		integrations = await readConnectorsFor(actor);
	}
	return { integrations, canManage, platformConfigured: computePlatformConfigured() };
}

/**
 * The connectors domain's reads (ADR 0005 D1, #6124). `board` is everything the connectors page
 * shows; the filter bar's selection and facet counts run over it in the browser — the catalog is one
 * short list, so every filter state is answered from the one cached read and a filter change
 * fetches nothing.
 */
export const connectorsRouter = {
	board: query.handler(({ context }) => readConnectorsBoard(context.actor)),
};
