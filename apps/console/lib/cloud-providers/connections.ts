// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, jobs, projects } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import { encryptSecret } from "@/lib/crypto/secrets";
import type { CloudCredentials } from "@/types/jsonb.types";

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

/** Clouds that assume a role with an ExternalId condition (zero stored credentials). */
const ROLE_CLOUDS: ReadonlySet<CloudProvider> = new Set(["aws", "alibaba"]);
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
 * connect — which is how one provider holds more than one account. For AWS/Alibaba
 * it also guarantees a stable external_id in the credentials. New rows are created
 * `scope: 'org'` so every org member (subject to role) sees them.
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

	if (existing) {
		if (!ROLE_CLOUDS.has(provider)) return { identityId: existing.id };

		const externalId = existing.credentials?.external_id ?? undefined;
		if (externalId) return { identityId: existing.id, externalId };

		const newExternalId = randomUUID();
		await db
			.update(cloudIdentities)
			.set({
				credentials: { ...existing.credentials, external_id: newExternalId },
			})
			.where(
				and(
					eq(cloudIdentities.id, existing.id),
					eq(cloudIdentities.org_id, scope.orgId),
				),
			);
		return { identityId: existing.id, externalId: newExternalId };
	}

	const externalId = ROLE_CLOUDS.has(provider) ? randomUUID() : undefined;
	const [created] = await db
		.insert(cloudIdentities)
		.values({
			user_id: scope.userId,
			org_id: scope.orgId,
			scope: "org",
			provider,
			name: PENDING_NAME[provider],
			credentials: externalId ? { external_id: externalId } : {},
			is_verified: false,
		})
		.returning({ id: cloudIdentities.id });

	return { identityId: created.id, externalId };
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

/** Inserts a QUEUED CONNECTION_TEST job and wakes the scaler. */
async function queueConnectionTest(
	scope: ConnScope,
	identityId: string,
	configSnapshot: Record<string, unknown>,
	opts?: { requiresSelfRunner?: boolean },
): Promise<string> {
	const db = getServiceDb();
	const [job] = await db
		.insert(jobs)
		.values({
			user_id: scope.userId,
			org_id: scope.orgId,
			job_type: "CONNECTION_TEST",
			cloud_identity_id: identityId,
			config_snapshot: configSnapshot,
			status: "QUEUED",
			requires_self_runner: opts?.requiresSelfRunner ?? false,
		})
		.returning({ id: jobs.id });

	notifyScaler();
	return job.id;
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

/** Validates a Role ARN, persists it, and queues a connection test. */
export async function saveAwsIdentity(
	scope: ConnScope,
	identityId: string,
	roleArn: string,
): Promise<{ jobId: string; identityId: string }> {
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

	const jobId = await queueConnectionTest(scope, identityId, {
		role_arn: roleArn,
		account_id: accountId,
	});
	return { jobId, identityId };
}

// --- GCP ---

/** Validates a WIF credential config JSON and extracts its key fields. */
export function parseWifConfig(wifConfigJson: string) {
	let parsed: Record<string, unknown>;
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

/** Validates a WIF config JSON, persists it, and queues a connection test. */
export async function saveGcpIdentity(
	scope: ConnScope,
	identityId: string,
	wifConfigJson: string,
): Promise<{ jobId: string; identityId: string }> {
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

	const jobId = await queueConnectionTest(scope, identityId, {
		project_id: projectId,
		project_number: projectNumber,
		service_account_email: serviceAccountEmail,
	});
	return { jobId, identityId };
}

// --- Azure ---

const GUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates the three Azure GUIDs, persists them, and queues a connection test. */
export async function saveAzureIdentity(
	scope: ConnScope,
	identityId: string,
	tenantId: string,
	clientId: string,
	subscriptionId: string,
): Promise<{ jobId: string; identityId: string }> {
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

	const jobId = await queueConnectionTest(scope, identityId, {
		tenant_id: tenantId,
		client_id: clientId,
		subscription_id: subscriptionId,
	});
	return { jobId, identityId };
}

// --- Alibaba (RAM role — zero stored credentials, like AWS) ---

const ALIBABA_ARN_REGEX = /^acs:ram::(\d+):role\/[\w+=,.@-]+$/;

/** Validates an Alibaba RAM role ARN, persists it, and queues a connection test. */
export async function saveAlibabaIdentity(
	scope: ConnScope,
	identityId: string,
	roleArn: string,
): Promise<{ jobId: string; identityId: string }> {
	const match = roleArn.match(ALIBABA_ARN_REGEX);
	if (!match) {
		throw new Error("Invalid format. Expected: acs:ram::5123456789012345:role/RoleName");
	}
	const accountId = match[1];
	const identity = await loadIdentity(scope, identityId);

	await getServiceDb()
		.update(cloudIdentities)
		.set({
			name: `Alibaba Cloud (${accountId})`,
			credentials: { ...identity.credentials, role_arn: roleArn, account_id: accountId },
			is_verified: false,
			status: "testing",
			last_error: null,
			updated_at: new Date(),
		})
		.where(
			and(eq(cloudIdentities.id, identityId), eq(cloudIdentities.org_id, scope.orgId)),
		);

	const jobId = await queueConnectionTest(scope, identityId, {
		role_arn: roleArn,
		account_id: accountId,
	});
	return { jobId, identityId };
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
): Promise<{ jobId: string; identityId: string }> {
	if (!TOKEN_CLOUDS.has(provider)) {
		throw new Error(`${provider} is not a token-authenticated cloud`);
	}
	const token = apiToken.trim();
	if (token.length < 16) {
		throw new Error("Invalid API token format");
	}
	const identity = await loadIdentity(scope, identityId);

	await getServiceDb()
		.update(cloudIdentities)
		.set({
			name: `${PENDING_NAME[provider].replace(" (Pending)", "")}`,
			credentials: { ...identity.credentials, token: encryptSecret({ api_token: token }) },
			is_verified: false,
			status: "testing",
			last_error: null,
			updated_at: new Date(),
		})
		.where(
			and(eq(cloudIdentities.id, identityId), eq(cloudIdentities.org_id, scope.orgId)),
		);

	// No secret in the snapshot — only a marker that a token connection test is requested.
	const jobId = await queueConnectionTest(scope, identityId, { token_connection_test: true });
	return { jobId, identityId };
}

/**
 * Connects a token cloud in SELF-MANAGED mode: Alethia stores NO token. The
 * customer's self-hosted runner supplies it from its own environment (HCLOUD_TOKEN,
 * CIVO_TOKEN, DIGITALOCEAN_ACCESS_TOKEN). The connection test is pinned to a
 * self-hosted runner (requires_self_runner) so a managed runner — which lacks the
 * token — never claims it. The honest zero-trust path for clouds with no federation.
 */
export async function saveSelfManagedTokenIdentity(
	scope: ConnScope,
	identityId: string,
	provider: CloudProvider,
): Promise<{ jobId: string; identityId: string }> {
	if (!TOKEN_CLOUDS.has(provider)) {
		throw new Error(`${provider} is not a token-authenticated cloud`);
	}
	const identity = await loadIdentity(scope, identityId);

	await getServiceDb()
		.update(cloudIdentities)
		.set({
			name: `${PENDING_NAME[provider].replace(" (Pending)", "")}`,
			// No token — drop any previously stored one and mark self-managed.
			credentials: { ...identity.credentials, token: null, self_managed: true },
			is_verified: false,
			status: "testing",
			last_error: null,
			updated_at: new Date(),
		})
		.where(
			and(eq(cloudIdentities.id, identityId), eq(cloudIdentities.org_id, scope.orgId)),
		);

	const jobId = await queueConnectionTest(
		scope,
		identityId,
		{ token_connection_test: true, self_managed: true },
		{ requiresSelfRunner: true },
	);
	return { jobId, identityId };
}

// --- Shared verify / disconnect ---

/**
 * Authoritatively records the outcome of a CONNECTION_TEST on the identity. Called
 * server-side from the job-status route the moment the runner reports SUCCESS/FAILED
 * (so a closed connect sheet can't strand a passed test as "not connected"), and
 * re-used by the client `verifyIdentity` refresh. Idempotent: the connected alert
 * fires only on the transition into connected; the opaque, runner-produced
 * `cached_resources` payload is written via raw jsonb assignment.
 */
export async function finalizeConnectionTest(
	identityId: string,
	ok: boolean,
	opts?: { errorMessage?: string | null; cached?: unknown },
): Promise<void> {
	const db = getServiceDb();
	const [before] = await db
		.select({
			status: cloudIdentities.status,
			org_id: cloudIdentities.org_id,
			provider: cloudIdentities.provider,
		})
		.from(cloudIdentities)
		.where(eq(cloudIdentities.id, identityId))
		.limit(1);
	if (!before) return;

	if (!ok) {
		await db
			.update(cloudIdentities)
			.set({
				status: "failed",
				last_error: opts?.errorMessage ?? "Verification failed.",
				last_tested_at: new Date(),
				updated_at: new Date(),
			})
			.where(eq(cloudIdentities.id, identityId));
		return;
	}

	const cached = opts?.cached;
	if (cached !== undefined && cached !== null) {
		await db.execute(
			sql`update cloud_identities
			    set is_verified = true, status = 'connected', last_error = null,
			        last_tested_at = now(), updated_at = now(),
			        cached_resources = ${JSON.stringify(cached)}::jsonb, cached_at = now()
			    where id = ${identityId}`,
		);
	} else {
		await db
			.update(cloudIdentities)
			.set({
				is_verified: true,
				status: "connected",
				last_error: null,
				last_tested_at: new Date(),
				updated_at: new Date(),
			})
			.where(eq(cloudIdentities.id, identityId));
	}

	// Ops alert (free) — only on the transition into connected (idempotent).
	if (before.status !== "connected" && before.org_id) {
		emitAlertEventSafe(before.org_id, "system.identity.connected", {
			title: `Cloud identity connected: ${before.provider}`,
			severity: "info",
			resource_type: "cloud_identity",
			resource_id: identityId,
		});
	}
}

/**
 * Client-invoked refresh after the connect sheet observes a SUCCESS job. The server
 * already finalizes via the job-status route, so this is best-effort/idempotent —
 * it just pulls the job's cached_resources and re-applies the connected state.
 */
export async function verifyIdentity(
	scope: ConnScope,
	identityId: string,
	jobId?: string,
): Promise<{ success: true }> {
	let cached: unknown;
	if (jobId) {
		const [job] = await getServiceDb()
			.select({ execution_metadata: jobs.execution_metadata })
			.from(jobs)
			.where(and(eq(jobs.id, jobId), eq(jobs.org_id, scope.orgId)))
			.limit(1);
		cached = job?.execution_metadata?.cached_resources;
	}
	await finalizeConnectionTest(identityId, true, { cached });
	return { success: true };
}

/**
 * Re-runs the CONNECTION_TEST for an already-saved identity without re-entering
 * credentials (e.g. after a failed verification). Rebuilds the job config_snapshot
 * from the stored credentials, flips the identity back to 'testing', and re-queues.
 */
export async function requeueConnectionTest(
	scope: ConnScope,
	identityId: string,
): Promise<{ jobId: string; identityId: string }> {
	const identity = await loadIdentity(scope, identityId);
	const c = identity.credentials;

	let snapshot: Record<string, unknown>;
	let requiresSelfRunner = false;
	switch (identity.provider) {
		case "aws":
		case "alibaba":
			snapshot = { role_arn: c.role_arn, account_id: c.account_id };
			break;
		case "gcp":
			snapshot = {
				project_id: c.project_id,
				project_number: c.project_number,
				service_account_email: c.service_account_email,
			};
			break;
		case "azure":
			snapshot = {
				tenant_id: c.tenant_id,
				client_id: c.client_id,
				subscription_id: c.subscription_id,
			};
			break;
		default:
			// Token clouds: self-managed (no stored token) vs encrypted stored token.
			requiresSelfRunner = !!c.self_managed;
			snapshot = c.self_managed
				? { token_connection_test: true, self_managed: true }
				: { token_connection_test: true };
	}

	await getServiceDb()
		.update(cloudIdentities)
		.set({ status: "testing", last_error: null, updated_at: new Date() })
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.org_id, scope.orgId),
			),
		);

	const jobId = await queueConnectionTest(scope, identityId, snapshot, {
		requiresSelfRunner,
	});
	return { jobId, identityId };
}

/**
 * Resets an identity to its pending state (preserving the AWS external_id) and
 * orphans any projects that referenced it.
 */
export async function disconnectIdentity(
	scope: ConnScope,
	identityId: string,
	provider: CloudProvider,
): Promise<{ success: true }> {
	const db = getServiceDb();

	let credentials: CloudCredentials = {};
	if (ROLE_CLOUDS.has(provider)) {
		const [identity] = await db
			.select({ credentials: cloudIdentities.credentials })
			.from(cloudIdentities)
			.where(
				and(
					eq(cloudIdentities.id, identityId),
					eq(cloudIdentities.org_id, scope.orgId),
				),
			)
			.limit(1);
		credentials = { external_id: identity?.credentials?.external_id };
	}

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
