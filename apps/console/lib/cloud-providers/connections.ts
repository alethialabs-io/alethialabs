// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, jobs, specs } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import type { CloudCredentials } from "@/types/database-custom.types";

/**
 * Cloud connection logic shared by the web console server actions and the CLI
 * API routes. Runs on the service connection (getServiceDb); every query filters
 * by `userId` explicitly so it stays owner-scoped without relying on RLS.
 */

export type CloudProvider = "aws" | "gcp" | "azure";

const PENDING_NAME: Record<CloudProvider, string> = {
	aws: "AWS Connection (Pending)",
	gcp: "GCP Connection (Pending)",
	azure: "Azure Connection (Pending)",
};

export type InitResult = { identityId: string; externalId?: string };

export type ConnectionStatus = {
	connected: boolean;
	identityId?: string;
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
};

/**
 * Gets or creates the single pending/verified identity row for a user+provider.
 * For AWS it also guarantees a stable external_id exists in the credentials.
 */
export async function initIdentity(
	userId: string,
	provider: CloudProvider,
): Promise<InitResult> {
	const db = getServiceDb();
	const [existing] = await db
		.select()
		.from(cloudIdentities)
		.where(
			and(
				eq(cloudIdentities.provider, provider),
				eq(cloudIdentities.user_id, userId),
			),
		)
		.limit(1);

	if (existing) {
		if (provider !== "aws") return { identityId: existing.id };

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
					eq(cloudIdentities.user_id, userId),
				),
			);
		return { identityId: existing.id, externalId: newExternalId };
	}

	const externalId = provider === "aws" ? randomUUID() : undefined;
	const [created] = await db
		.insert(cloudIdentities)
		.values({
			user_id: userId,
			provider,
			name: PENDING_NAME[provider],
			credentials: externalId ? { external_id: externalId } : {},
			is_verified: false,
		})
		.returning({ id: cloudIdentities.id });

	return { identityId: created.id, externalId };
}

/** Returns the verified connection status (and key fields) for a provider. */
export async function getStatus(
	userId: string,
	provider: CloudProvider,
): Promise<ConnectionStatus> {
	const db = getServiceDb();
	const [identity] = await db
		.select()
		.from(cloudIdentities)
		.where(
			and(
				eq(cloudIdentities.provider, provider),
				eq(cloudIdentities.user_id, userId),
				eq(cloudIdentities.is_verified, true),
			),
		)
		.limit(1);

	if (!identity) return { connected: false };

	const c = identity.credentials;
	switch (provider) {
		case "aws":
			return {
				connected: true,
				identityId: identity.id,
				accountId: c.account_id ?? undefined,
				roleArn: c.role_arn ?? undefined,
				externalId: c.external_id ?? undefined,
			};
		case "gcp":
			return {
				connected: true,
				identityId: identity.id,
				projectId: c.project_id ?? undefined,
				serviceAccountEmail: c.service_account_email ?? undefined,
			};
		case "azure":
			return {
				connected: true,
				identityId: identity.id,
				tenantId: c.tenant_id ?? undefined,
				clientId: c.client_id ?? undefined,
				subscriptionId: c.subscription_id ?? undefined,
			};
	}
}

/** Inserts a QUEUED CONNECTION_TEST job and wakes the scaler. */
async function queueConnectionTest(
	userId: string,
	identityId: string,
	configSnapshot: Record<string, unknown>,
): Promise<string> {
	const db = getServiceDb();
	const [job] = await db
		.insert(jobs)
		.values({
			user_id: userId,
			job_type: "CONNECTION_TEST",
			cloud_identity_id: identityId,
			config_snapshot: configSnapshot,
			status: "QUEUED",
		})
		.returning({ id: jobs.id });

	notifyScaler();
	return job.id;
}

/** Loads an identity row scoped to the user, throwing if it is missing. */
async function loadIdentity(userId: string, identityId: string) {
	const db = getServiceDb();
	const [identity] = await db
		.select()
		.from(cloudIdentities)
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.user_id, userId),
			),
		)
		.limit(1);

	if (!identity) throw new Error("Connection session not found");
	return identity;
}

// --- AWS ---

const ARN_REGEX = /^arn:aws:iam::(\d{12}):role\/[\w+=,.@-]+$/;

/** Validates a Role ARN, persists it, and queues a connection test. */
export async function saveAwsIdentity(
	userId: string,
	identityId: string,
	roleArn: string,
): Promise<{ jobId: string; identityId: string }> {
	const match = roleArn.match(ARN_REGEX);
	if (!match) {
		throw new Error(
			"Invalid format. Expected: arn:aws:iam::123456789012:role/RoleName",
		);
	}
	const accountId = match[1];

	const identity = await loadIdentity(userId, identityId);

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
			updated_at: new Date(),
		})
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.user_id, userId),
			),
		);

	const jobId = await queueConnectionTest(userId, identityId, {
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

	const projectNumberMatch = audience.match(/projects\/(\d+)\//);
	if (!projectNumberMatch) {
		throw new Error("Could not extract project number from audience.");
	}
	const projectNumber = projectNumberMatch[1];

	const saEmailMatch = impersonationUrl.match(
		/serviceAccounts\/([^:]+):generateAccessToken/,
	);
	if (!saEmailMatch) {
		throw new Error(
			"Could not extract service account email from impersonation URL.",
		);
	}
	const serviceAccountEmail = saEmailMatch[1];

	// Project id = the SA email domain's first label. Parsed with split() rather
	// than a regex to avoid polynomial backtracking on attacker-controlled input.
	const saDomain = serviceAccountEmail.split("@")[1];
	const projectId =
		saDomain && saDomain.includes(".") ? saDomain.split(".")[0] : undefined;

	return { parsed, projectNumber, serviceAccountEmail, projectId };
}

/** Validates a WIF config JSON, persists it, and queues a connection test. */
export async function saveGcpIdentity(
	userId: string,
	identityId: string,
	wifConfigJson: string,
): Promise<{ jobId: string; identityId: string }> {
	const { parsed, projectNumber, serviceAccountEmail, projectId } =
		parseWifConfig(wifConfigJson);

	await loadIdentity(userId, identityId);

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
			updated_at: new Date(),
		})
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.user_id, userId),
			),
		);

	const jobId = await queueConnectionTest(userId, identityId, {
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
	userId: string,
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

	await loadIdentity(userId, identityId);

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
			updated_at: new Date(),
		})
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.user_id, userId),
			),
		);

	const jobId = await queueConnectionTest(userId, identityId, {
		tenant_id: tenantId,
		client_id: clientId,
		subscription_id: subscriptionId,
	});
	return { jobId, identityId };
}

// --- Shared verify / disconnect ---

/**
 * Marks an identity verified, copying any cached_resources captured by the
 * CONNECTION_TEST job into the row. The cached payload is opaque (runner-produced)
 * so it is written via a raw jsonb assignment rather than the typed column.
 */
export async function verifyIdentity(
	userId: string,
	identityId: string,
	jobId?: string,
): Promise<{ success: true }> {
	const db = getServiceDb();

	let cached: unknown;
	if (jobId) {
		const [job] = await db
			.select({ execution_metadata: jobs.execution_metadata })
			.from(jobs)
			.where(and(eq(jobs.id, jobId), eq(jobs.user_id, userId)))
			.limit(1);
		cached = job?.execution_metadata?.cached_resources;
	}

	if (cached !== undefined && cached !== null) {
		await db.execute(
			sql`update cloud_identities
			    set is_verified = true, updated_at = now(),
			        cached_resources = ${JSON.stringify(cached)}::jsonb, cached_at = now()
			    where id = ${identityId} and user_id = ${userId}`,
		);
	} else {
		await db
			.update(cloudIdentities)
			.set({ is_verified: true, updated_at: new Date() })
			.where(
				and(
					eq(cloudIdentities.id, identityId),
					eq(cloudIdentities.user_id, userId),
				),
			);
	}

	return { success: true };
}

/**
 * Resets an identity to its pending state (preserving the AWS external_id) and
 * orphans any specs that referenced it.
 */
export async function disconnectIdentity(
	userId: string,
	identityId: string,
	provider: CloudProvider,
): Promise<{ success: true }> {
	const db = getServiceDb();

	let credentials: CloudCredentials = {};
	if (provider === "aws") {
		const [identity] = await db
			.select({ credentials: cloudIdentities.credentials })
			.from(cloudIdentities)
			.where(
				and(
					eq(cloudIdentities.id, identityId),
					eq(cloudIdentities.user_id, userId),
				),
			)
			.limit(1);
		credentials = { external_id: identity?.credentials?.external_id };
	}

	await db
		.update(cloudIdentities)
		.set({
			name: PENDING_NAME[provider],
			is_verified: false,
			credentials,
			cached_resources: null,
			cached_at: null,
			updated_at: new Date(),
		})
		.where(
			and(
				eq(cloudIdentities.id, identityId),
				eq(cloudIdentities.user_id, userId),
			),
		);

	await db
		.update(specs)
		.set({ cloud_identity_id: null })
		.where(eq(specs.cloud_identity_id, identityId));

	return { success: true };
}
