// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { captureServerException } from "@/lib/analytics/server";
import { log } from "@/lib/observability/log";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, projects } from "@/lib/db/schema";
import { encryptSecret } from "@/lib/crypto/secrets";
import { probeHealth, type HealthStatus } from "@/lib/cloud-providers/health";
import { deriveOidcProviderArn } from "@/lib/cloud-providers/session/alibaba";
import {
	purgeCloudInventory,
	syncCloudInventory,
} from "@/lib/cloud-providers/inventory";
import type { CloudCredentials, WifCredentialConfig } from "@/types/jsonb.types";
import { azureIdConflict } from "./azure-ids";
import { buildWifConfig, GCP_PROJECT_ID_REGEX } from "./gcp-wif";

/**
 * Cloud connection logic shared by the web console server actions and the CLI
 * API routes. Runs on the service connection (getServiceDb); every query filters
 * by `orgId` explicitly so connections are org-scoped (shared across the org's
 * members, subject to role) without relying on RLS. A provider can hold more than
 * one account — each verified identity is a distinct account row.
 */

export type CloudProvider =
	| "aws"
	| "gcp"
	| "azure"
	| "alibaba"
	| "digitalocean"
	| "hetzner"
	| "civo";

// NB: AWS and Alibaba are KEYLESS direct-OIDC now — AssumeRoleWithWebIdentity (AWS) and
// AssumeRoleWithOIDC (Alibaba) take NO ExternalId, and the customer's trust policy pins the issuer
// sub/aud, not an ExternalId. So there is no longer any "ExternalId role cloud": all managed clouds
// federate keyless, and the only stored value is the role ARN (a public identifier). The vestigial
// `external_id` minting was removed (it was stored + surfaced but never used by any assume).
/** Clouds with no role-federation — connected via a scoped API token (encrypted at rest). */
const TOKEN_CLOUDS: ReadonlySet<CloudProvider> = new Set([
	"digitalocean",
	"hetzner",
	"civo",
]);

const PENDING_NAME: Record<CloudProvider, string> = {
	aws: "AWS Connection (Pending)",
	gcp: "GCP Connection (Pending)",
	azure: "Azure Connection (Pending)",
	alibaba: "Alibaba Cloud Connection (Pending)",
	digitalocean: "DigitalOcean Connection (Pending)",
	hetzner: "Hetzner Connection (Pending)",
	civo: "Civo Connection (Pending)",
};

export type InitResult = { identityId: string; externalId?: string };

/**
 * The actor's tenancy scope. Cloud connections are **org-scoped**: every query
 * filters by `orgId` (the tenancy boundary, since this module runs on the service
 * connection without RLS), while `userId` is the acting identity recorded on jobs
 * and alerts. Community: `orgId === userId`. An `Actor` is assignable to this.
 */
export type ConnScope = { userId: string; orgId: string };

export type ConnectionStatus = {
	connected: boolean;
	identityId?: string;
	/** The account's display name (e.g. "AWS Account (123…)"). */
	name?: string;
	// AWS
	accountId?: string;
	roleArn?: string;
	externalId?: string;
	// GCP
	projectId?: string;
	serviceAccountEmail?: string;
	// Azure
	tenantId?: string;
	clientId?: string;
	subscriptionId?: string;
	// DigitalOcean / Hetzner / Civo (token clouds) — token is encrypted, never returned
	apiTokenSet?: boolean;
	// Self-managed: no token stored in Alethia; a self-hosted runner supplies it from its env
	selfManaged?: boolean;
};

/**
 * Gets or creates a **pending** identity row for the org+provider. Repeated
 * "Connect" clicks reuse the single dangling pending row rather than piling up
 * empties; once an account is verified a fresh pending row is created on the next
 * connect — which is how one provider holds more than one account. New rows are
 * created `scope: 'org'` so every org member (subject to role) sees them. All
 * managed clouds are keyless (no ExternalId), so the pending row carries no secret.
 */
export async function initIdentity(
	scope: ConnScope,
	provider: CloudProvider,
): Promise<InitResult> {
	const db = getServiceDb();
	const [existing] = await db
		.select()
		.from(cloudIdentities)
		.where(
			and(
				eq(cloudIdentities.provider, provider),
				eq(cloudIdentities.org_id, scope.orgId),
				eq(cloudIdentities.is_verified, false),
			),
		)
		.limit(1);

	if (existing) return { identityId: existing.id };

	const [created] = await db
		.insert(cloudIdentities)
		.values({
			user_id: scope.userId,
			org_id: scope.orgId,
			scope: "org",
			provider,
			name: PENDING_NAME[provider],
			credentials: {},
			is_verified: false,
		})
		.returning({ id: cloudIdentities.id });

	return { identityId: created.id };
}

/** Maps an identity row to the wire ConnectionStatus shape. */
function toStatus(
	identity: typeof cloudIdentities.$inferSelect,
): ConnectionStatus {
	const c = identity.credentials;
	const base = {
		connected: identity.is_verified ?? false,
		identityId: identity.id,
		name: identity.name,
	};
	switch (identity.provider) {
		case "aws":
		case "alibaba":
			return {
				...base,
				accountId: c.account_id ?? undefined,
				roleArn: c.role_arn ?? undefined,
				externalId: c.external_id ?? undefined,
			};
		case "gcp":
			return {
				...base,
				projectId: c.project_id ?? undefined,
				serviceAccountEmail: c.service_account_email ?? undefined,
			};
		case "azure":
			return {
				...base,
				tenantId: c.tenant_id ?? undefined,
				clientId: c.client_id ?? undefined,
				subscriptionId: c.subscription_id ?? undefined,
			};
		case "digitalocean":
		case "hetzner":
		case "civo":
			return {
				...base,
				apiTokenSet: !!c.token,
				selfManaged: !!c.self_managed,
			};
	}
}

/**
 * Lists every **verified** account for the org+provider (multi-account). Pending
 * connect sessions are excluded — they surface only through initIdentity.
 */
export async function listIdentities(
	scope: ConnScope,
	provider: CloudProvider,
): Promise<ConnectionStatus[]> {
	const db = getServiceDb();
	const rows = await db
		.select()
		.from(cloudIdentities)
		.where(
			and(
				eq(cloudIdentities.provider, provider),
				eq(cloudIdentities.org_id, scope.orgId),
				eq(cloudIdentities.is_verified, true),
			),
		)
		.orderBy(cloudIdentities.created_at);
	return rows.map(toStatus);
}

/** Returns the first verified account for a provider ("is any connected"). */
export async function getStatus(
	scope: ConnScope,
	provider: CloudProvider,
): Promise<ConnectionStatus> {
	const db = getServiceDb();
	const [identity] = await db
		.select()
		.from(cloudIdentities)
		.where(
			and(
				eq(cloudIdentities.provider, provider),
				eq(cloudIdentities.org_id, scope.orgId),
				eq(cloudIdentities.is_verified, true),
			),
		)
		.limit(1);

	if (!identity) return { connected: false };
	return toStatus(identity);
}

/** Renames a cloud account (org-scoped). */
export async function renameIdentity(
	scope: ConnScope,
	identityId: string,
	name: string,
): Promise<{ success: true }> {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Name cannot be empty");
	await getServiceDb()
		.update(cloudIdentities)
		.set({ name: trimmed.slice(0, 120), updated_at: new Date() })
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.org_id, scope.orgId),
			),
		);
	return { success: true };
}

/** Outcome of an instant server-side connection verify — surfaced straight to the connect UI. */
export interface ConnectionResult {
	identityId: string;
	/** True when the connection authenticated (connected or degraded); false when disconnected. */
	verified: boolean;
	status: HealthStatus;
	error: string | null;
	/** Provisioning permissions found missing (drives the DEGRADED hint), empty when connected. */
	missingPermissions: string[];
}

/**
 * Server-side connection verify (no runner, no job): probe the provider's health, persist the result to
 * the identity, and return the outcome for the connect UI to show instantly. Kicks off the initial asset
 * inventory in the background on success. Throws if the provider has no server-side probe (unknown
 * provider) — every managed provider is server-side, so callers can rely on a result.
 */
async function verifyConnectionInline(
	scope: ConnScope,
	identityId: string,
): Promise<ConnectionResult> {
	const db = getServiceDb();
	const identity = await loadIdentity(scope, identityId);
	const result = await probeHealth(identity);
	if (!result) {
		throw new Error(`No server-side health probe for provider "${identity.provider}".`);
	}

	const ok = result.status !== "disconnected";
	await db
		.update(cloudIdentities)
		.set({
			is_verified: ok,
			status: result.status, // connected | degraded | disconnected
			last_error: result.error,
			last_tested_at: new Date(),
			verified_account_id: result.accountId,
			missing_permissions: result.missingPermissions,
			updated_at: new Date(),
		})
		.where(eq(cloudIdentities.id, identityId));

	// ── Observability (BYOC connector-parity debugging). Connect/verify failures are otherwise
	//    INVISIBLE server-side: the probe never throws, the error is only persisted to
	//    cloud_identities.last_error and returned to the browser — so nothing reached the logs or
	//    error tracking. Emit a structured line for EVERY outcome (one `cloud connection verify`
	//    body, level by severity) so PostHog logs carry the exact per-provider result, and report a
	//    real exception to PostHog Error tracking on a hard failure so a broken keyless federation
	//    (AWS/Azure/Alibaba OIDC trust, sub/aud mismatch, …) surfaces as an issue with the message.
	//    Both channels are NEXT_PUBLIC_POSTHOG_KEY-gated (no key ⇒ no-op) and never throw. ──
	const logFields = {
		org_id: scope.orgId,
		provider: identity.provider,
		identity_id: identityId,
		status: result.status,
		last_error: result.error,
		missing_permissions: result.missingPermissions.length
			? result.missingPermissions.join(",")
			: undefined,
	};
	if (result.status === "disconnected") {
		log.error("cloud connection verify failed", logFields);
		void captureServerException(
			new Error(`Cloud connection verify failed for ${identity.provider}: ${result.error ?? "unknown error"}`),
			{ orgId: scope.orgId, props: { provider: identity.provider, identity_id: identityId } },
		);
	} else if (result.status === "degraded") {
		log.warn("cloud connection verify degraded (missing permissions)", logFields);
	} else {
		log.info("cloud connection verify succeeded", logFields);
	}

	// Ops alert on the transition into a healthy (connected/degraded) state.
	if (ok && identity.status !== "connected" && scope.orgId) {
		emitAlertEventSafe(scope.orgId, "system.identity.connected", {
			title: `Cloud identity connected: ${identity.provider}`,
			severity: "info",
			resource_type: "cloud_identity",
			resource_id: identityId,
		});
	}

	// Kick off the initial asset inventory in the background (best-effort; the periodic
	// reconciliation sweep is the reliable backstop). Reload creds so the probe's updates are seen.
	if (ok) {
		const fresh = await loadIdentity(scope, identityId).catch(() => null);
		if (fresh) void syncCloudInventory(fresh);
	}

	return {
		identityId,
		verified: ok,
		status: result.status,
		error: result.error,
		missingPermissions: result.missingPermissions,
	};
}

/** Loads an identity row scoped to the org, throwing if it is missing. */
async function loadIdentity(scope: ConnScope, identityId: string) {
	const db = getServiceDb();
	const [identity] = await db
		.select()
		.from(cloudIdentities)
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.org_id, scope.orgId),
			),
		)
		.limit(1);

	if (!identity) throw new Error("Connection session not found");
	return identity;
}

// --- AWS ---

const ARN_REGEX = /^arn:aws:iam::(\d{12}):role\/[\w+=,.@-]+$/;

/**
 * Validates an AWS IAM Role ARN and extracts its 12-digit account id. Throws on a
 * malformed ARN (wrong service, non-role resource, bad account length). Pure — shared
 * by saveAwsIdentity and unit-tested directly.
 */
export function parseAwsRoleArn(roleArn: string): { accountId: string } {
	const match = roleArn.match(ARN_REGEX);
	if (!match) {
		throw new Error(
			"Invalid format. Expected: arn:aws:iam::123456789012:role/RoleName",
		);
	}
	return { accountId: match[1] };
}

/** Validates a Role ARN, persists it, and verifies the connection server-side (no runner). */
export async function saveAwsIdentity(
	scope: ConnScope,
	identityId: string,
	roleArn: string,
): Promise<ConnectionResult> {
	const { accountId } = parseAwsRoleArn(roleArn);

	const identity = await loadIdentity(scope, identityId);

	await getServiceDb()
		.update(cloudIdentities)
		.set({
			name: `AWS Account (${accountId})`,
			credentials: {
				...identity.credentials,
				role_arn: roleArn,
				account_id: accountId,
			},
			is_verified: false,
			status: "testing",
			last_error: null,
			updated_at: new Date(),
		})
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.org_id, scope.orgId),
			),
		);

	// AWS verifies server-side (no runner) — assume the role + capability probe, inline.
	return verifyConnectionInline(scope, identityId);
}

// --- GCP ---

/** Validates a WIF credential config JSON and extracts its key fields. */
export function parseWifConfig(wifConfigJson: string) {
	let parsed: WifCredentialConfig;
	try {
		parsed = JSON.parse(wifConfigJson);
	} catch {
		throw new Error("Invalid JSON format");
	}

	if (parsed.type !== "external_account") {
		throw new Error(
			'Invalid credential type. Expected "external_account" (Workload Identity Federation config).',
		);
	}

	const audience = typeof parsed.audience === "string" ? parsed.audience : undefined;
	if (!audience || !audience.includes("workloadIdentityPools")) {
		throw new Error(
			"Missing or invalid audience field. This should reference a Workload Identity Pool.",
		);
	}

	const impersonationUrl =
		typeof parsed.service_account_impersonation_url === "string"
			? parsed.service_account_impersonation_url
			: undefined;
	if (!impersonationUrl) {
		throw new Error(
			"Missing service_account_impersonation_url. Ensure the credential config includes service account impersonation.",
		);
	}

	if (!parsed.credential_source) {
		throw new Error("Missing credential_source in the configuration.");
	}

	// Parsed with indexOf/split rather than regexes to avoid polynomial backtracking
	// on attacker-controlled input (same rationale as the SA-domain parse below).
	const projMarker = "projects/";
	const projStart = audience.indexOf(projMarker);
	const projectNumber =
		projStart === -1
			? ""
			: audience.slice(projStart + projMarker.length).split("/")[0];
	if (!projectNumber || !/^\d+$/.test(projectNumber)) {
		throw new Error("Could not extract project number from audience.");
	}

	const saMarker = "serviceAccounts/";
	const saStart = impersonationUrl.indexOf(saMarker);
	const serviceAccountEmail =
		saStart === -1
			? ""
			: impersonationUrl
					.slice(saStart + saMarker.length)
					.split(":generateAccessToken")[0]
					.split(":")[0];
	if (!serviceAccountEmail) {
		throw new Error(
			"Could not extract service account email from impersonation URL.",
		);
	}

	// Project id = the SA email domain's first label. Parsed with split() rather
	// than a regex to avoid polynomial backtracking on attacker-controlled input.
	const saDomain = serviceAccountEmail.split("@")[1];
	const projectId =
		saDomain && saDomain.includes(".") ? saDomain.split(".")[0] : undefined;

	return { parsed, projectNumber, serviceAccountEmail, projectId };
}

/** Validates a WIF config JSON, persists it, and verifies the connection server-side (no runner). */
export async function saveGcpIdentity(
	scope: ConnScope,
	identityId: string,
	wifConfigJson: string,
): Promise<ConnectionResult> {
	const { parsed, projectNumber, serviceAccountEmail, projectId } =
		parseWifConfig(wifConfigJson);

	await loadIdentity(scope, identityId);

	await getServiceDb()
		.update(cloudIdentities)
		.set({
			name: `GCP Project (${projectId ?? projectNumber})`,
			credentials: {
				project_id: projectId,
				project_number: projectNumber,
				service_account_email: serviceAccountEmail,
				wif_config: parsed,
			},
			is_verified: false,
			status: "testing",
			last_error: null,
			updated_at: new Date(),
		})
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.org_id, scope.orgId),
			),
		);

	// GCP verifies server-side (WIF token + a Compute read) — no runner.
	return verifyConnectionInline(scope, identityId);
}

/**
 * Builds the WIF config from a project id + number (the two values the setup prints) and saves +
 * verifies it — the primary connect path. Reuses saveGcpIdentity's persist + verify by handing it the
 * assembled JSON, so both paths behave identically.
 */
export async function saveGcpIdentityFromIds(
	scope: ConnScope,
	identityId: string,
	projectId: string,
	projectNumber: string,
): Promise<ConnectionResult> {
	const pid = projectId.trim();
	const num = projectNumber.trim();
	if (!GCP_PROJECT_ID_REGEX.test(pid)) {
		throw new Error(
			"Invalid GCP project ID (6–30 chars: lowercase letters, digits, hyphens; starts with a letter).",
		);
	}
	if (!/^\d{1,20}$/.test(num)) {
		throw new Error("Project number must be digits only.");
	}
	return saveGcpIdentity(scope, identityId, JSON.stringify(buildWifConfig(pid, num)));
}

// --- Azure ---

const GUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates the three Azure GUIDs, persists them, and verifies the connection server-side (no runner). */
export async function saveAzureIdentity(
	scope: ConnScope,
	identityId: string,
	tenantId: string,
	clientId: string,
	subscriptionId: string,
): Promise<ConnectionResult> {
	if (!GUID_REGEX.test(tenantId)) {
		throw new Error("Invalid Tenant ID format. Expected a UUID.");
	}
	if (!GUID_REGEX.test(clientId)) {
		throw new Error(
			"Invalid Client ID (Application ID) format. Expected a UUID.",
		);
	}
	if (!GUID_REGEX.test(subscriptionId)) {
		throw new Error("Invalid Subscription ID format. Expected a UUID.");
	}
	// The tenant, the managed identity's application id and the subscription name three different
	// things, so a repeat is always a mis-paste — most often the Subscription ID landing in Client ID,
	// which only fails later with an opaque AADSTS700016. The connect form checks this too, but the
	// CLI reaches this action directly, so the form is not the boundary.
	const conflict = azureIdConflict({ tenantId, clientId, subscriptionId });
	if (conflict) throw new Error(conflict.message);

	await loadIdentity(scope, identityId);

	await getServiceDb()
		.update(cloudIdentities)
		.set({
			name: `Azure Subscription (${subscriptionId.slice(0, 8)}...)`,
			credentials: {
				tenant_id: tenantId,
				client_id: clientId,
				subscription_id: subscriptionId,
			},
			is_verified: false,
			status: "testing",
			last_error: null,
			updated_at: new Date(),
		})
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.org_id, scope.orgId),
			),
		);

	// Azure verifies server-side (auth AS the customer's managed identity + an ARM read) — no runner.
	return verifyConnectionInline(scope, identityId);
}

// --- Alibaba (RAM role — zero stored credentials, like AWS) ---

const ALIBABA_ARN_REGEX = /^acs:ram::(\d+):role\/[\w+=,.@-]+$/;

/** Validates an Alibaba RAM role ARN, persists it, and verifies the connection server-side (no runner). */
export async function saveAlibabaIdentity(
	scope: ConnScope,
	identityId: string,
	roleArn: string,
): Promise<ConnectionResult> {
	const match = roleArn.match(ALIBABA_ARN_REGEX);
	if (!match) {
		throw new Error("Invalid format. Expected: acs:ram::5123456789012345:role/RoleName");
	}
	const accountId = match[1];
	const identity = await loadIdentity(scope, identityId);

	// The OIDC provider ARN is derived from the account id + the fixed provider name the customer
	// setup module creates (`infra/connector/alibaba`), so the connect form only needs the role ARN.
	const oidcProviderArn = deriveOidcProviderArn(roleArn);

	await getServiceDb()
		.update(cloudIdentities)
		.set({
			name: `Alibaba Cloud (${accountId})`,
			credentials: {
				...identity.credentials,
				role_arn: roleArn,
				account_id: accountId,
				oidc_provider_arn: oidcProviderArn,
			},
			is_verified: false,
			status: "testing",
			last_error: null,
			updated_at: new Date(),
		})
		.where(
			and(eq(cloudIdentities.id, identityId), eq(cloudIdentities.org_id, scope.orgId)),
		);

	// Alibaba verifies server-side (RAM-role AssumeRole via platform STS) — no runner.
	return verifyConnectionInline(scope, identityId);
}

// --- Token clouds (DigitalOcean / Hetzner / Civo) — scoped API token, encrypted at rest ---

/**
 * Stores a scoped API token (encrypted via AES-GCM; decrypted only on the runner)
 * and queues a connection test. The plaintext token is NEVER placed in the job
 * config_snapshot — the claim route decrypts `credentials.token` and hands it to the
 * runner directly, mirroring the pluggable-connector credential flow.
 */
export async function saveTokenCloudIdentity(
	scope: ConnScope,
	identityId: string,
	provider: CloudProvider,
	apiToken: string,
	s3AccessKey?: string,
	s3SecretKey?: string,
): Promise<ConnectionResult> {
	if (!TOKEN_CLOUDS.has(provider)) {
		throw new Error(`${provider} is not a token-authenticated cloud`);
	}
	const token = apiToken.trim();
	if (token.length < 16) {
		throw new Error("Invalid API token format");
	}
	const identity = await loadIdentity(scope, identityId);

	const credentials: CloudCredentials = {
		...identity.credentials,
		token: encryptSecret({ api_token: token }),
	};

	// Hetzner Object Storage S3 keys (optional, both-or-neither): DISTINCT from the Cloud API
	// token and manually generated by the customer (no mint API). Encrypted at rest like the
	// token; the runner decrypts them at claim to provision buckets via the minio provider.
	if (provider === "hetzner") {
		const ak = s3AccessKey?.trim();
		const sk = s3SecretKey?.trim();
		if ((ak && !sk) || (!ak && sk)) {
			throw new Error(
				"Provide both the Hetzner S3 access key and secret key, or neither.",
			);
		}
		credentials.s3_access_key = ak ? encryptSecret({ access_key: ak }) : null;
		credentials.s3_secret_key = sk ? encryptSecret({ secret_key: sk }) : null;
	}

	await getServiceDb()
		.update(cloudIdentities)
		.set({
			name: `${PENDING_NAME[provider].replace(" (Pending)", "")}`,
			credentials,
			is_verified: false,
			status: "testing",
			last_error: null,
			updated_at: new Date(),
		})
		.where(
			and(eq(cloudIdentities.id, identityId), eq(cloudIdentities.org_id, scope.orgId)),
		);

	// Token clouds verify server-side (HTTP probe with the stored token) — no runner.
	return verifyConnectionInline(scope, identityId);
}

// --- Shared re-verify / disconnect ---

/**
 * Re-verifies an already-saved identity server-side without re-entering credentials
 * (e.g. the "Re-verify" affordance on a degraded/disconnected connector, or a periodic
 * refresh). Flips the identity to 'testing', re-probes health, and persists the result —
 * returning it for the caller to surface. No runner, no job.
 */
export async function reverifyConnection(
	scope: ConnScope,
	identityId: string,
): Promise<ConnectionResult> {
	await getServiceDb()
		.update(cloudIdentities)
		.set({ status: "testing", last_error: null, updated_at: new Date() })
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.org_id, scope.orgId),
			),
		);

	return verifyConnectionInline(scope, identityId);
}

/**
 * Resets an identity to its pending state (clearing all stored credentials) and
 * orphans any projects that referenced it.
 */
export async function disconnectIdentity(
	scope: ConnScope,
	identityId: string,
	provider: CloudProvider,
): Promise<{ success: true }> {
	const db = getServiceDb();

	// Load the row (by id + org) and assert its provider matches the caller's arg. The update below
	// filters by id + org only (id is the PK), so a mismatched `provider` would relabel the row with the
	// wrong PENDING_NAME. Fail loudly on a mismatch; a missing row keeps the old no-op behavior (the
	// update simply affects nothing).
	const [identity] = await db
		.select({ provider: cloudIdentities.provider })
		.from(cloudIdentities)
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.org_id, scope.orgId),
			),
		)
		.limit(1);
	if (identity && identity.provider !== provider) {
		throw new Error(
			`Provider mismatch: cloud identity ${identityId} is ${identity.provider}, not ${provider}.`,
		);
	}

	// All managed clouds are keyless — disconnect clears credentials entirely (no ExternalId to preserve).
	const credentials: CloudCredentials = {};

	const [disconnected] = await db
		.update(cloudIdentities)
		.set({
			name: PENDING_NAME[provider],
			is_verified: false,
			status: "pending",
			last_error: null,
			last_tested_at: null,
			credentials,
			cached_resources: null,
			cached_at: null,
			updated_at: new Date(),
		})
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.org_id, scope.orgId),
			),
		)
		.returning({ org_id: cloudIdentities.org_id });

	await db
		.update(projects)
		.set({ cloud_identity_id: null })
		.where(eq(projects.cloud_identity_id, identityId));

	// Purge the stored asset inventory — we keep no projection of a cloud we no longer access.
	await purgeCloudInventory(identityId);

	// Ops alert (free): a cloud identity was revoked/disconnected.
	if (disconnected?.org_id) {
		emitAlertEventSafe(disconnected.org_id, "system.identity.revoked", {
			title: `Cloud identity disconnected: ${provider}`,
			severity: "warning",
			actor_id: scope.userId,
			resource_type: "cloud_identity",
			resource_id: identityId,
		});
	}

	return { success: true };
}
