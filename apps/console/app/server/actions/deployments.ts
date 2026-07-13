"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getServiceDb } from "@/lib/db";
import { transitionEnv } from "@/lib/db/env-status";
import {
	jobs,
	projectCaches,
	projectCluster,
	projectDatabases,
	projectDns,
	projectEnvironments,
	projectIacSources,
	projectNosqlTables,
	projectQueues,
	projectSecrets,
	projectSourceRepos,
	projectTopics,
} from "@/lib/db/schema";
import {
	recordAddonHealth,
	recordSecurityPosture,
} from "@/lib/addons/inspection-persistence";
import { structuralHash } from "@/lib/promotions/diff";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";
import type { ProviderOutputs } from "@/types/jsonb.types";

/** Service DB handle (RLS-bypassing). */
type ServiceDb = ReturnType<typeof getServiceDb>;

// execution_metadata is JSONB written by the runner. Parse the fields we read
// (lenient: .catch(undefined) mirrors the old optional-read behavior without casts).
const deployMetaSchema = z.object({
	cluster_name: z.string().optional().catch(undefined),
	cluster_endpoint: z.string().optional().catch(undefined),
	argocd_url: z.string().optional().catch(undefined),
	// NOTE: argocd_admin_password is intentionally NOT read here. The runner no longer persists
	// the ArgoCD admin password into execution_metadata (it is retrieved on-demand from the
	// cluster's argocd-initial-admin-secret); the console never stores or displays a plaintext one.
	outputs: z.record(z.string(), z.unknown()).optional().catch(undefined),
	// Managed marketplace add-on health, keyed by ArgoCD Application name ("addon-<id>").
	addon_status: z
		.record(
			z.string(),
			z.object({ health: z.string(), sync: z.string() }),
		)
		.optional()
		.catch(undefined),
	// Cluster Trivy-Operator vulnerability posture (L9).
	security_report: z
		.object({
			critical: z.number(),
			high: z.number(),
			medium: z.number(),
			low: z.number(),
			report_count: z.number(),
			scanned: z.boolean(),
		})
		.optional()
		.catch(undefined),
});

// The BYO-IaC slice of a job's config_snapshot — the only key finalizeDeployment reads from it.
// Lenient: unknown keys are stripped and a malformed snapshot yields {} (never throws).
const iacSnapshotSchema = z
	.object({
		iac_source: z
			.object({ commit_sha: z.string().nullish().catch(null) })
			.optional(),
	})
	.catch({});

/**
 * After a DEPLOY job succeeds, persist terraform outputs to the project component
 * tables. Service path — runs on the BYPASSRLS connection (runner-triggered).
 *
 * Also tracks BYO-IaC (E3) deployed state on the env's project_iac_sources row: a successful
 * DEPLOY records the commit it applied (so DESTROY can later tear down THAT exact module, and
 * detach stays blocked while live BYO infra exists); a successful DESTROY clears it. No-op for
 * template envs (no iac source row matches the update).
 */
export async function finalizeDeployment(jobId: string) {
	const db = getServiceDb();

	const [job] = await db
		.select({
			status: jobs.status,
			org_id: jobs.org_id,
			project_id: jobs.project_id,
			environment_id: jobs.environment_id,
			job_type: jobs.job_type,
			config_snapshot: jobs.config_snapshot,
			execution_metadata: jobs.execution_metadata,
		})
		.from(jobs)
		.where(eq(jobs.id, jobId))
		.limit(1);

	if (!job) return;
	if (job.status !== "SUCCESS") return;
	if (!job.project_id) return;
	if (!job.environment_id) return;

	// BYO-IaC deployed-commit tracking runs BEFORE the DEPLOY-only / metadata guards below so it
	// also fires for DESTROY (which carries no tofu outputs). DEPLOY pins the commit it applied so
	// a later DESTROY tears down THAT exact module (and detach stays blocked while live BYO infra
	// exists); DESTROY clears the pin. Only BYO envs carry `iac_source` in the snapshot, so a
	// template env skips this entirely (no stray write).
	if (job.job_type === "DEPLOY" || job.job_type === "DESTROY") {
		const snap = iacSnapshotSchema.parse(job.config_snapshot ?? {});
		if (snap.iac_source) {
			await db
				.update(projectIacSources)
				.set({
					deployed_commit_sha:
						job.job_type === "DEPLOY" ? (snap.iac_source.commit_sha ?? null) : null,
					updated_at: new Date(),
				})
				.where(
					and(
						eq(projectIacSources.project_id, job.project_id),
						eq(projectIacSources.environment_id, job.environment_id),
					),
				);
		}
	}

	if (job.job_type !== "DEPLOY") return;
	if (!job.execution_metadata) return;

	const projectId = job.project_id;
	// Components are environment-scoped — write outputs back only to the deployed env's rows.
	const environmentId = job.environment_id;
	const inEnv = (
		table:
			| typeof projectCluster
			| typeof projectDatabases
			| typeof projectCaches
			| typeof projectQueues,
	) => and(eq(table.project_id, projectId), eq(table.environment_id, environmentId));
	const meta = deployMetaSchema.parse(job.execution_metadata);
	const outputs = meta.outputs;

	// Gate the ENTIRE deploy writeback — the env row AND every child component row (cluster / db /
	// cache status + live endpoints), addon health, and security posture — on the env-status CAS,
	// hoisted here so it runs BEFORE any write. `deploySuccess` is legal only from PROVISIONING|QUEUED,
	// so a late DEPLOY-SUCCESS arriving after a DESTROY already tore the env down (env=DESTROYED)
	// rejects and we write NOTHING. Previously only the env row was CAS-protected; the child rows were
	// written unconditionally, so a straggler resurrected a `cluster_endpoint`/argocd_url onto a
	// destroyed env — the more visible half of the last-writer-wins bug. transitionEnv logged + emitted
	// a status-conflict alert on the reject; we just bail.
	// Ordering note: because the env is moved to ACTIVE up front, if a *component write below* throws,
	// the status route's catch → deployFailed is a no-op (ACTIVE ∉ deployFailed.from) and the env stays
	// ACTIVE. That is intentional and correct: the runner reported SUCCESS, so the infra genuinely
	// exists — a metadata-writeback error must not flip a live deploy to FAILED (it only warns).
	if (environmentId) {
		const moved = await transitionEnv(db, environmentId, "deploySuccess", jobId, {
			orgId: job.org_id,
			projectId,
		});
		if (!moved) return;
	}

	const clusterUpdate: Partial<typeof projectCluster.$inferInsert> = {
		status: "ACTIVE",
	};
	if (meta.cluster_name) clusterUpdate.cluster_name = meta.cluster_name;
	if (meta.cluster_endpoint)
		clusterUpdate.cluster_endpoint = meta.cluster_endpoint;
	// argocd_url reflects THIS deploy: the runner reports it only when an ingress was
	// actually configured, so an absent key on a successful deploy means "no reachable
	// URL" and must CLEAR any previously persisted one (older deploys wrote a bogus
	// https://argocd.<domain> on clouds where no ingress exists).
	clusterUpdate.argocd_url = meta.argocd_url ?? null;
	if (outputs) {
		const clusterArn = extractOutputValue(outputs, "eks_cluster_arn");
		if (clusterArn) clusterUpdate.provider_outputs = { arn: clusterArn };
	}

	await db.update(projectCluster).set(clusterUpdate).where(inEnv(projectCluster));

	// Marketplace add-on health + Trivy security posture — the runner read them back post-apply.
	// Shared with the day-2 DETECT_DRIFT refresh path (lib/addons/inspection-persistence).
	if (meta.addon_status) {
		await recordAddonHealth(projectId, environmentId, meta.addon_status);
	}

	// Hetzner in-cluster data services deploy as ArgoCD Applications (addon-db-* / addon-cache-* /
	// addon-queue-*), not managed cloud resources — so their status comes from the Application
	// health, not tofu outputs. Reflect it onto the matching component rows. Endpoint discovery is
	// chart-specific and deferred. Safe on the managed clouds: those Application names don't exist,
	// so nothing matches and the tofu-output writeback below stays authoritative.
	if (meta.addon_status) {
		const addonStatus = meta.addon_status;
		const statusForApp = (
			appName: string,
		): "ACTIVE" | "CREATING" | "FAILED" | null => {
			switch (addonStatus[appName]?.health) {
				case "Healthy":
					return "ACTIVE";
				case "Progressing":
					return "CREATING";
				case "Degraded":
					return "FAILED";
				default:
					return null;
			}
		};
		const dbRows = await db
			.select()
			.from(projectDatabases)
			.where(inEnv(projectDatabases));
		for (const d of dbRows) {
			const s = statusForApp(`addon-db-${d.name}`);
			if (s)
				await db
					.update(projectDatabases)
					.set({ status: s })
					.where(eq(projectDatabases.id, d.id));
		}
		const cacheRows = await db
			.select()
			.from(projectCaches)
			.where(inEnv(projectCaches));
		for (const c of cacheRows) {
			const s = statusForApp(`addon-cache-${c.name}`);
			if (s)
				await db
					.update(projectCaches)
					.set({ status: s })
					.where(eq(projectCaches.id, c.id));
		}
		const queueRows = await db
			.select()
			.from(projectQueues)
			.where(inEnv(projectQueues));
		for (const q of queueRows) {
			const s = statusForApp(`addon-queue-${q.name}`);
			if (s)
				await db
					.update(projectQueues)
					.set({ status: s })
					.where(eq(projectQueues.id, q.id));
		}
	}
	if (meta.security_report) {
		await recordSecurityPosture(projectId, environmentId, meta.security_report);
	}

	if (outputs) {
		const rdsEndpoint = extractOutputValue(outputs, "rds_cluster_endpoint");
		if (rdsEndpoint) {
			const dbOutputs: ProviderOutputs = {};
			const rdsId = extractOutputValue(outputs, "rds_cluster_identifier");
			if (rdsId) dbOutputs.identifier = rdsId;
			const rdsArn = extractOutputValue(outputs, "rds_cluster_arn");
			if (rdsArn) dbOutputs.arn = rdsArn;
			const masterSecret = extractOutputValue(
				outputs,
				"rds_master_credentials_secret_arn",
			);
			if (masterSecret) dbOutputs.secret_ref = masterSecret;
			const extraSecret = extractOutputValue(
				outputs,
				"rds_extra_credentials_secret_arn",
			);
			if (extraSecret) dbOutputs.extra_secret_ref = extraSecret;
			const kmsKey = extractOutputValue(
				outputs,
				"rds_credentials_kms_key_arn",
			);
			if (kmsKey) dbOutputs.kms_key = kmsKey;

			const dbUpdate: Partial<typeof projectDatabases.$inferInsert> = {
				endpoint: rdsEndpoint,
				status: "ACTIVE",
				provider_outputs: dbOutputs,
			};

			await db
				.update(projectDatabases)
				.set(dbUpdate)
				.where(inEnv(projectDatabases));
		}

		const redisEndpoint = extractOutputValue(
			outputs,
			"redis_primary_endpoint_address",
		);
		if (redisEndpoint) {
			const cacheUpdate: Partial<typeof projectCaches.$inferInsert> = {
				endpoint: redisEndpoint,
				status: "ACTIVE",
			};
			const readerEndpoint = extractOutputValue(
				outputs,
				"redis_reader_endpoint_address",
			);
			if (readerEndpoint) cacheUpdate.reader_endpoint = readerEndpoint;

			await db
				.update(projectCaches)
				.set(cacheUpdate)
				.where(inEnv(projectCaches));
		}
	}

	// M1: stamp the day-2 governance fields on the now-ACTIVE env: the deployed design's structural
	// fingerprint + timestamp (predecessor gate, soak timer, config-vs-desired divergence), and reset
	// the auto-heal failure counter. The env→ACTIVE CAS ran at the top of the DEPLOY block and we
	// returned early if it was rejected, so reaching here means the env legitimately moved to ACTIVE.
	if (environmentId) {
		const deployedHash = await deployedStructuralHash(db, projectId, environmentId);
		await db
			.update(projectEnvironments)
			.set({
				deployed_config_hash: deployedHash,
				last_deployed_at: new Date(),
				auto_heal_failures: 0,
				// Fresh infra = fresh reap budget: a successful (re)deploy clears any prior ephemeral-reaper
				// bookkeeping so an env that previously gave up (or was mid-backoff) is reaped normally at
				// its next expiry, instead of being permanently excluded by the isNull(reap_gave_up_at) gate.
				reap_attempts: 0,
				last_reap_at: null,
				reap_gave_up_at: null,
			})
			.where(eq(projectEnvironments.id, environmentId));
	}
}

/**
 * The structural fingerprint of an environment's currently-designed components, computed from the
 * component rows (service role — no session). Matches `structuralHash(ProjectFormData)` so it can be
 * compared against a promotion's `candidate_hash`. Only structural fields feed the hash, so the
 * env-tunable defaults filled in here don't affect it.
 */
async function deployedStructuralHash(
	db: ServiceDb,
	projectId: string,
	environmentId: string,
): Promise<string> {
	const scope = (
		table:
			| typeof projectCluster
			| typeof projectDns
			| typeof projectDatabases
			| typeof projectCaches
			| typeof projectQueues
			| typeof projectTopics
			| typeof projectNosqlTables
			| typeof projectSecrets
			| typeof projectSourceRepos,
	) => and(eq(table.project_id, projectId), eq(table.environment_id, environmentId));

	const [cluster] = await db.select().from(projectCluster).where(scope(projectCluster)).limit(1);
	const [dns] = await db.select().from(projectDns).where(scope(projectDns)).limit(1);
	const databases = await db.select().from(projectDatabases).where(scope(projectDatabases));
	const caches = await db.select().from(projectCaches).where(scope(projectCaches));
	const queues = await db.select().from(projectQueues).where(scope(projectQueues));
	const topics = await db.select().from(projectTopics).where(scope(projectTopics));
	const nosql = await db.select().from(projectNosqlTables).where(scope(projectNosqlTables));
	const secrets = await db.select().from(projectSecrets).where(scope(projectSecrets));
	const sourceRepos = await db.select().from(projectSourceRepos).where(scope(projectSourceRepos));

	// Minimal ProjectFormData — only structural fields matter to structuralHash; the rest are inert.
	const design: ProjectFormData = {
		project: {
			project_name: "",
			environment_stage: "development",
			region: "",
			cloud_identity_id: "",
			iac_version: "",
		},
		network: { provision_network: true, cidr_block: "10.0.0.0/16", single_nat_gateway: true },
		cluster: {
			cluster_version: cluster?.cluster_version ?? "",
			instance_types: [],
			node_min_size: 0,
			node_max_size: 0,
			node_desired_size: 0,
			cluster_admins: [],
			provider_config: {},
		},
		dns: {
			enabled: dns?.enabled ?? false,
			managed_certificate: dns?.managed_certificate ?? false,
			waf_enabled: dns?.waf_enabled ?? false,
		},
		repositories: {},
		source_repos: sourceRepos.map((r) => ({
			repo_url: r.repo_url,
			scan_path: r.scan_path,
			services: r.services ?? [],
		})),
		databases: databases.map((d) => ({
			name: d.name,
			engine: d.engine ?? undefined,
			engine_version: d.engine_version ?? undefined,
			port: d.port ?? undefined,
			iam_auth: d.iam_auth ?? undefined,
		})),
		caches: caches.map((c) => ({
			name: c.name,
			engine: c.engine ?? undefined,
			engine_version: c.engine_version ?? undefined,
		})),
		queues: queues.map((q) => ({ name: q.name, ordered: q.ordered ?? undefined })),
		topics: topics.map((t) => ({ name: t.name, subscriptions: t.subscriptions ?? undefined })),
		nosql_tables: nosql.map((n) => ({
			name: n.name,
			partition_key: n.partition_key,
			partition_key_type: n.partition_key_type ?? undefined,
			sort_key: n.sort_key ?? undefined,
			sort_key_type: n.sort_key_type ?? undefined,
			table_type: n.table_type ?? undefined,
		})),
		secrets: secrets.map((s) => ({
			name: s.name,
			generate: s.generate ?? undefined,
			length: s.length ?? undefined,
			special_chars: s.special_chars ?? undefined,
		})),
		// Not structural inputs to the hash — inert, present only to satisfy the shape.
		storage_buckets: [],
		container_registries: [],
	};
	return structuralHash(design);
}

/** Extracts a string from a terraform output entry (raw string or { value }). */
function extractOutputValue(
	outputs: Record<string, unknown>,
	key: string,
): string | null {
	const val = outputs[key];
	if (!val) return null;
	if (typeof val === "string") return val;
	if (typeof val === "object" && val !== null && "value" in val) {
		const v = val.value;
		if (typeof v === "string") return v;
	}
	return null;
}
