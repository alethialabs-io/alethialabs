// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Direct-DB seeding for e2e preconditions the UI can't cheaply produce — a connected cloud identity,
// a project + environment, a "finished" deploy (clusters/DB/cache ACTIVE with endpoints, mimicking
// finalizeDeployment), queued/finished jobs, and drift. Inserts run as the owner role (RLS bypassed);
// every row sets BOTH user_id AND org_id to the target persona so the app's RLS-scoped queries see it.
//
// Enums (exact): provision_job_status = QUEUED|CLAIMED|PROCESSING|SUCCESS|FAILED|CANCELLED (NOT
// SUCCEEDED); component_status = PENDING|CREATING|ACTIVE|UPDATING|FAILED|DESTROYING|DESTROYED;
// project_status = DRAFT|QUEUED|PROVISIONING|ACTIVE|FAILED|DESTROYING|DESTROYED; cloud_provider =
// aws|azure|gcp|alibaba|digitalocean|hetzner|civo; cloud_identity_status = pending|testing|connected|
// degraded|disconnected|failed.

import { cloudProvider } from "@/lib/db/schema/enums";
import { slugifyOrEmpty } from "@/lib/utils/slugify";
import type { CloudCredentials } from "@/types/jsonb.types";

import { db } from "./db";

/** The persona identity every seeded row is scoped to. */
export interface Owner {
	userId: string;
	orgId: string;
}

/** Every provider `cloud_identities.provider` admits — read from the enum, never retyped. */
export const SEED_PROVIDERS = cloudProvider.enumValues;

/** One of the providers a seeded cloud identity can carry. */
export type SeedProvider = (typeof SEED_PROVIDERS)[number];

/** The AWS account number every AWS-shaped fixture in this file already used. Unchanged on purpose. */
const AWS_ACCOUNT_ID = "123456789012";
const ALIBABA_ACCOUNT_ID = "5123456789012345";
const GCP_PROJECT_ID = "e2e-gcp-project";
const AZURE_SUBSCRIPTION_ID = "00000000-0000-4000-8000-00000000e2e0";

/**
 * The credential a seeded identity carries, SHAPED FOR ITS PROVIDER.
 *
 * WHY THIS IS NOT ONE CONSTANT (#4708). It was: `{role_arn: "arn:aws:iam::…"}`, for every provider.
 * `identityWasConfigured()` (`lib/cloud-providers/identity-configured.ts`) is provider-aware — it
 * demands a project or service account for gcp, and a subscription or tenant for azure — so a
 * seeded GCP or Azure identity was filtered out of the connectors board as a never-configured
 * placeholder. Nothing errored: the row inserted, the read succeeded, the predicate answered
 * `false`. The tile read "Not enabled on this instance", `ConnectorCard`'s `isPick` went false with
 * it, and a Playwright click on that tile did NOTHING — silently, for 120 seconds.
 *
 * `tests/e2e-helpers/seed-credentials.test.ts` holds every one of these against that predicate, in
 * both directions, so this cannot drift back.
 *
 * `satisfies Record<SeedProvider, CloudCredentials>` is doing two jobs. It type-checks each entry
 * against the real JSONB shape, and it makes the KEY SET exhaustive — a cloud added to the
 * `cloud_provider` enum with no credential here fails at tsc rather than inheriting a neighbour's,
 * which is the whole defect. It is `satisfies` and not an annotation because the entries must keep
 * their literal types: postgres.js's `sql.json` takes a `JSONValue`, and TypeScript grants an
 * implicit index signature to an inferred object type but never to a named interface, so an
 * entry typed as `CloudCredentials` would not be insertable.
 *
 * The token clouds get `self_managed: true` rather than a token: `CloudCredentials.token` holds an
 * `EncryptedSecret`, not a string, and self-managed is a REAL supported mode (the runner supplies
 * the token from its own environment) whose stored credential is genuinely absent. A hand-built
 * fake ciphertext would be a fixture invented rather than captured.
 */
const SEED_CREDENTIALS = {
	aws: { role_arn: `arn:aws:iam::${AWS_ACCOUNT_ID}:role/e2e` },
	// Alibaba is the other role cloud, but its ARNs are `acs:ram:`, not `arn:aws:iam:`. The
	// predicate only asks that one be present; a fixture that lies about the namespace is the next
	// reader's wrong answer.
	alibaba: {
		role_arn: `acs:ram::${ALIBABA_ACCOUNT_ID}:role/e2e`,
		oidc_provider_arn: `acs:ram::${ALIBABA_ACCOUNT_ID}:oidc-provider/e2e`,
	},
	gcp: {
		project_id: GCP_PROJECT_ID,
		service_account_email: `e2e@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
	},
	azure: {
		subscription_id: AZURE_SUBSCRIPTION_ID,
		tenant_id: "00000000-0000-4000-8000-00000000e2e1",
	},
	digitalocean: { self_managed: true },
	hetzner: { self_managed: true },
	civo: { self_managed: true },
} satisfies Record<SeedProvider, CloudCredentials>;

/** The credential `seedCloudIdentity` writes for a provider. See {@link SEED_CREDENTIALS}. */
export function seedCredentials(provider: SeedProvider) {
	return SEED_CREDENTIALS[provider];
}

/**
 * The account the seeded identity's probe "authenticated as" (`verified_account_id`).
 *
 * ONE VALUE FOR SEVEN PROVIDERS WAS A COLLISION STANDING IN THE FIXTURES. That column is how
 * `app/api/cloud-events/[provider]/route.ts` resolves an inbound cloud event back to an identity,
 * and `lib/cloud-providers/events/ingest.ts` names a cross-provider collision on it as a hazard.
 * The token clouds return null: their account id is the token's owner, which self-managed mode
 * never learns.
 */
export function seedAccountId(provider: SeedProvider): string | null {
	switch (provider) {
		case "aws":
			return AWS_ACCOUNT_ID;
		case "alibaba":
			return ALIBABA_ACCOUNT_ID;
		case "gcp":
			return GCP_PROJECT_ID;
		case "azure":
			return AZURE_SUBSCRIPTION_ID;
		case "digitalocean":
		case "hetzner":
		case "civo":
			// No account id: a self-managed token cloud stores no credential, so nothing was ever
			// authenticated as anything. `verified_account_id` is nullable and this is the honest null.
			return null;
		default: {
			const _exhaustive: never = provider;
			return _exhaustive;
		}
	}
}

/** Inserts a verified/connected cloud identity so a project can link it and Connectors shows it. */
export async function seedCloudIdentity(
	owner: Owner,
	opts: { provider?: SeedProvider; name?: string; verified?: boolean } = {},
): Promise<{ id: string }> {
	const sql = db();
	const provider = opts.provider ?? "aws";
	const verified = opts.verified ?? true;
	const [row] = await sql<{ id: string }[]>`
		insert into cloud_identities ${sql({
			user_id: owner.userId,
			org_id: owner.orgId,
			scope: "org",
			provider,
			name: opts.name ?? `E2E ${provider.toUpperCase()} account`,
			credentials: sql.json(seedCredentials(provider)),
			is_verified: verified,
			status: verified ? "connected" : "pending",
			verified_account_id: verified ? seedAccountId(provider) : null,
		})}
		returning id`;
	return row;
}

export interface SeededProject {
	projectId: string;
	envId: string;
	slug: string;
	name: string;
}

/**
 * Inserts a project + its default environment + a cluster/network component row + the org→project
 * hierarchy edge. Enough for project surfaces (architecture, jobs, settings, clusters) to render.
 * Components start PENDING (undeployed) unless seedFinishedDeploy is called after.
 */
export async function seedProject(
	owner: Owner,
	opts: { name?: string; region?: string; cloudIdentityId?: string; status?: string } = {},
): Promise<SeededProject> {
	const sql = db();
	const name = opts.name ?? `e2e-project-${Date.now()}`;
	const slug = slugifyOrEmpty(name);
	const region = opts.region ?? "eu-central-1";
	const [proj] = await sql<{ id: string }[]>`
		insert into projects ${sql({
			user_id: owner.userId,
			org_id: owner.orgId,
			cloud_identity_id: opts.cloudIdentityId ?? null,
			project_name: name,
			slug,
			region,
			iac_version: "1.8.0",
		})}
		returning id`;
	const projectId = proj.id;

	const [env] = await sql<{ id: string }[]>`
		insert into project_environments ${sql({
			project_id: projectId,
			user_id: owner.userId,
			org_id: owner.orgId,
			name: "production",
			stage: "production",
			status: opts.status ?? "DRAFT",
			is_default: true,
			region,
		})}
		returning id`;
	const envId = env.id;

	// A network + cluster component so the design/clusters surfaces have something to show.
	await sql`
		insert into project_network ${sql({
			project_id: projectId,
			environment_id: envId,
			cloud_identity_id: opts.cloudIdentityId ?? null,
			status: "PENDING",
		})}`;
	await sql`
		insert into project_cluster ${sql({
			project_id: projectId,
			environment_id: envId,
			cloud_identity_id: opts.cloudIdentityId ?? null,
			status: "PENDING",
		})}`;

	// org → project hierarchy edge (permission cascades).
	await sql`
		insert into resource_hierarchy ${sql({
			child_type: "project",
			child_id: projectId,
			parent_type: "org",
			parent_id: owner.orgId,
		})}
		on conflict do nothing`;

	return { projectId, envId, slug, name };
}

/**
 * Mimics finalizeDeployment: flips the environment + cluster to ACTIVE and stamps cluster outputs
 * (name/endpoint/argocd), so the Clusters page + artifact panels render a "deployed" project without
 * a real runner. Call after seedProject.
 */
export async function seedFinishedDeploy(project: Pick<SeededProject, "projectId" | "envId">): Promise<void> {
	const sql = db();
	await sql`
		update project_cluster set
			status = 'ACTIVE',
			cluster_name = 'e2e-eks-cluster',
			cluster_endpoint = 'https://e2e.eks.eu-central-1.amazonaws.com',
			argocd_url = 'https://argocd.e2e.example.com',
			provider_outputs = ${sql.json({ arn: "arn:aws:eks:eu-central-1:123456789012:cluster/e2e" })},
			updated_at = now()
		where project_id = ${project.projectId} and environment_id = ${project.envId}`;
	await sql`
		update project_environments set
			status = 'ACTIVE',
			deployed_config_hash = 'e2e-deployed-hash',
			last_deployed_at = now(),
			auto_heal_failures = 0,
			updated_at = now()
		where id = ${project.envId}`;
}

/** Inserts a provisioning job in the given state (default a finished DEPLOY). */
export async function seedJob(
	owner: Owner,
	opts: {
		jobType?: string;
		status?: string;
		projectId?: string;
		envId?: string;
		cloudIdentityId?: string;
		provider?: string;
		errorMessage?: string;
	} = {},
): Promise<{ id: string }> {
	const sql = db();
	const status = opts.status ?? "SUCCESS";
	const [row] = await sql<{ id: string }[]>`
		insert into jobs ${sql({
			user_id: owner.userId,
			org_id: owner.orgId,
			project_id: opts.projectId ?? null,
			environment_id: opts.envId ?? null,
			cloud_identity_id: opts.cloudIdentityId ?? null,
			job_type: opts.jobType ?? "DEPLOY",
			config_snapshot: sql.json({}),
			status,
			provider: opts.provider ?? "aws",
			error_message: opts.errorMessage ?? null,
			completed_at: ["SUCCESS", "FAILED", "CANCELLED"].includes(status) ? new Date() : null,
		})}
		returning id`;
	return row;
}

/** Inserts a drift record for an environment (in_sync=false with N drifted resources by default). */
export async function seedDrift(
	project: Pick<SeededProject, "projectId" | "envId">,
	opts: { inSync?: boolean; drifted?: number } = {},
): Promise<void> {
	const sql = db();
	const inSync = opts.inSync ?? false;
	const drifted = opts.drifted ?? (inSync ? 0 : 2);
	await sql`
		insert into environment_drift ${sql({
			project_id: project.projectId,
			environment_id: project.envId,
			in_sync: inSync,
			drifted,
			details: sql.json(
				inSync
					? []
					: [
							{ resource: "aws_security_group.node", change: "modified" },
							{ resource: "aws_iam_role.cluster", change: "modified" },
						],
			),
		})}
		on conflict (project_id, environment_id) do update set
			in_sync = excluded.in_sync, drifted = excluded.drifted, details = excluded.details, updated_at = now()`;
}

/** Deletes everything scoped to an org (projects cascade to components/jobs-null), for isolation. */
export async function cleanupOrg(orgId: string): Promise<void> {
	const sql = db();
	await sql`delete from jobs where org_id = ${orgId}`;
	await sql`delete from projects where org_id = ${orgId}`;
	await sql`delete from cloud_identities where org_id = ${orgId}`;
	await sql`delete from environment_drift where project_id in (select id from projects where org_id = ${orgId})`;
}
