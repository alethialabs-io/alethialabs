// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db";
import {
	auditLog,
	cloudIdentities,
	environmentCost,
	environmentDrift,
	environmentSecurity,
	fleetActions,
	fleetPools,
	jobLogs,
	jobs,
	member,
	organization,
	organizationBilling,
	projectAddons,
	projectCaches,
	projectCluster,
	projectContainerRegistries,
	projectDatabases,
	projectDns,
	projectEnvironments,
	projectIacSources,
	projectNetwork,
	projectRepositories,
	projectStorageBuckets,
	projects,
	resourceHierarchy,
	runnerReleases,
	runnerUsageSessions,
	runners,
	team,
	teamMember,
	user,
} from "@/lib/db/schema";
import type { CostResourceLine, ExecutionMetadata } from "@/types/jsonb.types";
import {
	CONNECTORS,
	DEMO,
	PROJECTS,
	type CloudProvider,
	type EnvSpec,
	type ProjectSpec,
	deployLog,
	planLog,
	planSha,
	receipt,
	verifyReport,
} from "./catalog";
import { makeIds } from "./ids";

export interface SeedCtx {
	db: Db;
	ownerId: string;
	orgId: string; // community tenancy: orgId === ownerId
	ownerEmail: string;
	slug: string;
	id: (name: string) => string;
	now: Date;
}

/** Fixed deterministic ids for the global (org-less) fleet rows this seed owns. */
export function fleetIds(id: (name: string) => string) {
	return {
		releases: [id("release:v1.9.0"), id("release:v1.8.4")],
		runners: [id("runner:eu-1"), id("runner:eu-2"), id("runner:us-1"), id("runner:hetzner-1")],
		pools: [id("pool:aws"), id("pool:hetzner")],
		actions: [id("action:1"), id("action:2")],
	};
}

/** Resolves the demo owner: reuse an existing user by email, else create one. */
export async function resolveOwner(db: Db, email: string, id: (name: string) => string): Promise<string> {
	const existing = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
	if (existing.length > 0) return existing[0].id;
	const ownerId = id("user:owner");
	await db
		.insert(user)
		.values({ id: ownerId, name: DEMO.ownerName, email, emailVerified: true, onboardingCompletedAt: new Date() })
		.onConflictDoNothing();
	return ownerId;
}

/** Org row (id unified with owner id), members, teams, enterprise billing. */
export async function seedOrgAndPeople(ctx: SeedCtx): Promise<void> {
	const { db, ownerId, orgId, id, now } = ctx;

	await db
		.insert(organization)
		.values({
			id: orgId,
			name: DEMO.orgName,
			slug: ctx.slug,
			metadata: JSON.stringify({ demo: true, seededAt: now.toISOString(), seeder: "seed-demo" }),
		})
		.onConflictDoUpdate({
			target: organization.id,
			set: { name: DEMO.orgName, slug: ctx.slug, metadata: JSON.stringify({ demo: true, seededAt: now.toISOString(), seeder: "seed-demo" }) },
		});

	// Owner membership.
	await db
		.insert(member)
		.values({ id: id("member:owner"), organizationId: orgId, userId: ownerId, role: "owner", status: "active" })
		.onConflictDoNothing();

	// Additional members (each needs a user row).
	for (const m of DEMO.members) {
		const uid = id(`user:${m.email}`);
		await db
			.insert(user)
			.values({ id: uid, name: m.name, email: m.email, emailVerified: true })
			.onConflictDoNothing();
		await db
			.insert(member)
			.values({ id: id(`member:${m.email}`), organizationId: orgId, userId: uid, role: m.role, status: "active" })
			.onConflictDoNothing();
	}

	// Teams.
	for (const t of DEMO.teams) {
		await db.insert(team).values({ id: id(`team:${t}`), name: t, organizationId: orgId }).onConflictDoNothing();
		await db.insert(teamMember).values({ id: id(`team-member:${t}:owner`), teamId: id(`team:${t}`), userId: ownerId }).onConflictDoNothing();
	}

	// Enterprise billing (entitlements resolve immediately).
	const periodStart = new Date(now.getTime() - 20 * 24 * 3600 * 1000);
	const periodEnd = new Date(now.getTime() + 345 * 24 * 3600 * 1000);
	await db
		.insert(organizationBilling)
		.values({ organizationId: orgId, plan: "enterprise", status: "active", seats: 12, currentPeriodStart: periodStart, currentPeriodEnd: periodEnd })
		.onConflictDoUpdate({ target: organizationBilling.organizationId, set: { plan: "enterprise", status: "active", seats: 12, currentPeriodStart: periodStart, currentPeriodEnd: periodEnd } });
}

/** Keyless cloud connectors; returns provider → cloud_identity id. */
export async function seedConnectors(ctx: SeedCtx): Promise<Record<CloudProvider, string>> {
	const { db, ownerId, orgId, id, now } = ctx;
	// @ts-expect-error filled completely in the loop below; keeps the finite Record<CloudProvider,string> key type (which Record<string,string> would lose)
	const map: Record<CloudProvider, string> = {};
	for (const c of CONNECTORS) {
		const cid = id(`connector:${c.provider}`);
		map[c.provider] = cid;
		await db
			.insert(cloudIdentities)
			.values({
				id: cid,
				user_id: ownerId,
				org_id: orgId,
				scope: "org",
				provider: c.provider,
				name: c.name,
				credentials: c.credentials,
				cached_resources: c.cachedResources ?? undefined,
				cached_at: c.cachedResources ? now : undefined,
				is_verified: true,
				status: "connected",
				verified_account_id: c.verifiedAccountId ?? undefined,
				last_tested_at: now,
			})
			.onConflictDoNothing();
	}
	return map;
}

/** Projects, environments, the ReBAC edge, and the full component graph. */
export async function seedProjects(
	ctx: SeedCtx,
	connectors: Record<CloudProvider, string>,
): Promise<{ project: ProjectSpec; projectId: string; envs: { env: EnvSpec; envId: string }[] }[]> {
	const { db, ownerId, orgId, now } = ctx;
	const out: { project: ProjectSpec; projectId: string; envs: { env: EnvSpec; envId: string }[] }[] = [];

	for (const p of PROJECTS) {
		const pid = ctx.id(`project:${p.key}`);
		const connectorId = connectors[p.provider];
		const prodCost = p.environments.find((e) => e.stage === "production")?.monthlyCost ?? p.environments[0].monthlyCost;

		await db
			.insert(projects)
			.values({
				id: pid,
				user_id: ownerId,
				org_id: orgId,
				cloud_identity_id: connectorId,
				project_name: p.name,
				slug: p.key,
				region: p.region,
				iac_version: "1.0.0",
				estimated_monthly_cost: prodCost,
			})
			.onConflictDoNothing();

		await db
			.insert(resourceHierarchy)
			.values({ child_type: "project", child_id: pid, parent_type: "org", parent_id: orgId })
			.onConflictDoNothing();

		await db.insert(auditLog).values({ project_id: pid, user_id: ownerId, action: "CREATED", changes: { project_name: p.name } }).onConflictDoNothing();

		const envs: { env: EnvSpec; envId: string }[] = [];
		for (const env of p.environments) {
			const envId = ctx.id(`project:${p.key}/env/${env.stage}`);
			const factor = env.monthlyCost / prodCost;
			await db
				.insert(projectEnvironments)
				.values({
					id: envId,
					project_id: pid,
					user_id: ownerId,
					org_id: orgId,
					name: env.stage,
					stage: env.stage,
					status: "ACTIVE",
					is_default: env.isDefault,
					region: p.region,
					lifecycle: "persistent",
					auto_heal: env.stage === "production",
					deployed_config_hash: planSha(`${p.key}/${env.stage}`).slice(0, 16),
					last_deployed_at: new Date(now.getTime() - 3 * 3600 * 1000),
				})
				.onConflictDoNothing();
			await seedComponents(ctx, p, pid, envId, factor);
			envs.push({ env, envId });
		}
		out.push({ project: p, projectId: pid, envs });
	}
	return out;
}

/** Inserts the per-environment component graph (mirrors writeComponents mapping). */
async function seedComponents(ctx: SeedCtx, p: ProjectSpec, projectId: string, environmentId: string, factor: number): Promise<void> {
	const { db } = ctx;
	const c = p.components;
	const base = { project_id: projectId, environment_id: environmentId, region: p.region, status: "ACTIVE" as const };
	const scale = (n: number) => Math.round(n * factor);

	const otherCosts =
		c.databases.reduce((s, d) => s + scale(d.cost), 0) +
		c.caches.reduce((s, x) => s + scale(x.cost), 0) +
		c.buckets.reduce((s, b) => s + scale(b.cost), 0);
	const clusterCost = Math.max(60, scale(p.environments.find((e) => e.monthlyCost)?.monthlyCost ?? 0) - otherCosts);

	await db.insert(projectNetwork).values({ ...base, provision_network: true, cidr_block: c.network.cidr_block, single_nat_gateway: c.network.single_nat_gateway, estimated_monthly_cost: scale(32) }).onConflictDoNothing();

	await db
		.insert(projectCluster)
		.values({
			...base,
			cluster_version: c.cluster.version,
			instance_types: c.cluster.instance_types,
			node_min_size: c.cluster.node_min,
			node_desired_size: c.cluster.node_desired,
			node_max_size: c.cluster.node_max,
			node_disk_size_gb: 80,
			cluster_name: c.cluster.name,
			cluster_endpoint: c.cluster.endpoint,
			argocd_url: c.cluster.argocd_url,
			estimated_monthly_cost: clusterCost,
		})
		.onConflictDoNothing();

	if (c.dns) {
		await db.insert(projectDns).values({ ...base, enabled: c.dns.enabled, provider: c.dns.provider, domain_name: c.dns.domain_name, managed_certificate: true, estimated_monthly_cost: 1 }).onConflictDoNothing();
	}
	await db.insert(projectRepositories).values({ project_id: projectId, environment_id: environmentId, apps_destination_repo: `github.com/acme/${p.key}-gitops` }).onConflictDoNothing();

	for (const d of c.databases) {
		await db.insert(projectDatabases).values({ ...base, name: d.name, engine_family: d.engine_family, engine: d.engine, endpoint: d.endpoint, estimated_monthly_cost: scale(d.cost) }).onConflictDoNothing();
	}
	for (const x of c.caches) {
		await db.insert(projectCaches).values({ ...base, name: x.name, engine: x.engine, endpoint: x.endpoint, estimated_monthly_cost: scale(x.cost) }).onConflictDoNothing();
	}
	for (const b of c.buckets) {
		await db.insert(projectStorageBuckets).values({ ...base, name: b.name, versioning: true, encryption_enabled: true, estimated_monthly_cost: scale(b.cost) }).onConflictDoNothing();
	}
	for (const r of c.registries) {
		await db.insert(projectContainerRegistries).values({ ...base, name: r.name, repository_url: r.repository_url }).onConflictDoNothing();
	}
	for (const a of c.addons) {
		await db
			.insert(projectAddons)
			.values({ project_id: projectId, environment_id: environmentId, addon_id: a.addon_id, source: "catalog", enabled: true, mode: "managed", version: a.version, namespace: a.namespace, health: "Healthy", sync_status: "Synced", scan_status: "done", last_synced_at: ctx.now, status: "ACTIVE" })
			.onConflictDoNothing();
	}
	if (c.iac) {
		await db
			.insert(projectIacSources)
			.values({ project_id: projectId, environment_id: environmentId, name: c.iac.name, repo_url: c.iac.repo_url, path: c.iac.path, commit_sha: c.iac.commit_sha, deployed_commit_sha: c.iac.commit_sha, enabled: true, scan_status: "done", scanned_at: ctx.now, status: "ACTIVE" })
			.onConflictDoNothing();
	}
}

/** Jobs (+ logs), evidence (verify_result + receipt), drift, security, cost. */
export async function seedJobsAndEvidence(
	ctx: SeedCtx,
	seeded: { project: ProjectSpec; projectId: string; envs: { env: EnvSpec; envId: string }[] }[],
	connectors: Record<CloudProvider, string>,
): Promise<void> {
	const { db, ownerId, orgId, now } = ctx;
	const minsAgo = (m: number) => new Date(now.getTime() - m * 60 * 1000);

	for (const { project: p, projectId, envs } of seeded) {
		const provider = p.provider;
		const runnerId = ctx.id("runner:eu-1");
		const addCount = 30 + p.components.databases.length * 6 + p.components.caches.length * 4;

		for (const { env, envId } of envs) {
			const report = verifyReport(provider, env.verdict);
			const evalAt = minsAgo(180).toISOString();
			const rcpt = receipt(report, provider, `${p.key}/${env.stage}`, evalAt);

			const planId = ctx.id(`job:${p.key}/${env.stage}/plan`);
			const deployId = ctx.id(`job:${p.key}/${env.stage}/deploy`);
			const snapshot = { provider, region: p.region, environment_stage: env.stage, environment_id: envId, cluster: { cluster_name: p.components.cluster.name, cluster_version: p.components.cluster.version } };

			// PLAN (SUCCESS) — carries verify_result + receipt + cost.
			await db
				.insert(jobs)
				.values({
					id: planId,
					user_id: ownerId,
					org_id: orgId,
					project_id: projectId,
					environment_id: envId,
					cloud_identity_id: connectors[provider],
					job_type: "PLAN",
					provider,
					status: "SUCCESS",
					config_snapshot: snapshot,
					runner_id: runnerId,
					assigned_runner_id: runnerId,
					claimed_at: minsAgo(184),
					started_at: minsAgo(184),
					completed_at: minsAgo(182),
					execution_metadata: {
						plan_result: { add: addCount, change: 0, destroy: 0 },
						cost_breakdown: { total_monthly: env.monthlyCost },
						verify_result: report,
						verify_receipt: rcpt,
					} satisfies ExecutionMetadata,
				})
				.onConflictDoNothing();
			await insertLogs(db, planId, planLog(p, addCount));

			// DEPLOY (SUCCESS) — the latest verify per env; carries gitops + security + receipt.
			await db
				.insert(jobs)
				.values({
					id: deployId,
					user_id: ownerId,
					org_id: orgId,
					project_id: projectId,
					environment_id: envId,
					cloud_identity_id: connectors[provider],
					job_type: "DEPLOY",
					provider,
					status: "SUCCESS",
					config_snapshot: snapshot,
					runner_id: runnerId,
					assigned_runner_id: runnerId,
					plan_job_id: planId,
					claimed_at: minsAgo(180),
					started_at: minsAgo(180),
					completed_at: minsAgo(168),
					verify_override: env.waiver ? { controls: env.waiver.controls, reason: env.waiver.reason, by: DEMO.ownerEmail } : undefined,
					execution_metadata: {
						cluster_name: p.components.cluster.name,
						cluster_endpoint: p.components.cluster.endpoint,
						cluster_ready: true,
						argocd_url: p.components.cluster.argocd_url,
						verify_result: report,
						verify_receipt: rcpt,
						security_report: { critical: 0, high: env.stage === "production" ? 0 : 1, medium: 2, low: 5, report_count: 8, scanned: true },
						addon_status: Object.fromEntries(p.components.addons.map((a) => [a.addon_id, { health: "Healthy", sync: "Synced" }])),
						gitops_status: { mode: "gitops", apps_repo: `github.com/acme/${p.key}-gitops`, argocd_app: p.key, revision: planSha(`${p.key}/${env.stage}`).slice(0, 7), app_health: { health: "Healthy", sync: "Synced" } },
					} satisfies ExecutionMetadata,
				})
				.onConflictDoNothing();
			await insertLogs(db, deployId, deployLog(p));

			// Day-2 posture rows.
			await db
				.insert(environmentDrift)
				.values({ project_id: projectId, environment_id: envId, in_sync: env.drifted === 0, drifted: env.drifted, details: env.drifted > 0 ? Array.from({ length: env.drifted }, (_, i) => ({ address: `module.cluster.node[${i}]`, type: "kubernetes_node", kind: "modified" })) : [], scanned_at: minsAgo(30) })
				.onConflictDoNothing();
			await db
				.insert(environmentSecurity)
				.values({ project_id: projectId, environment_id: envId, critical: 0, high: env.stage === "production" ? 0 : 1, medium: 2, low: 5, report_count: 8, scanned: true, scanned_at: minsAgo(168) })
				.onConflictDoNothing();
			const resources: CostResourceLine[] = [
				{ address: "module.cluster", resourceType: "kubernetes_cluster", monthlyCost: Math.round(env.monthlyCost * 0.55) },
				...p.components.databases.map((d) => ({ address: `module.database.${d.name}`, resourceType: d.engine, monthlyCost: Math.round(d.cost * (env.monthlyCost / (p.environments[0].monthlyCost || 1))) })),
			];
			await db.insert(environmentCost).values({ project_id: projectId, environment_id: envId, plan_job_id: planId, total_monthly: env.monthlyCost, currency: "USD", resources, captured_at: minsAgo(182) }).onConflictDoNothing();
		}

		// One drift-detection job at project level (SUCCESS) + a live-spectrum pair.
		const defaultEnv = envs.find((e) => e.env.isDefault) ?? envs[0];
		const driftId = ctx.id(`job:${p.key}/drift`);
		await db
			.insert(jobs)
			.values({ id: driftId, user_id: ownerId, org_id: orgId, project_id: projectId, environment_id: defaultEnv.envId, cloud_identity_id: connectors[provider], job_type: "DETECT_DRIFT", provider, status: "SUCCESS", config_snapshot: {}, runner_id: runnerId, claimed_at: minsAgo(32), started_at: minsAgo(32), completed_at: minsAgo(30), execution_metadata: { drift_posture: { in_sync: defaultEnv.env.drifted === 0, drifted: defaultEnv.env.drifted, unmanaged: 0, unmanaged_known: true, scanned_at: minsAgo(30).toISOString() } } satisfies ExecutionMetadata })
			.onConflictDoNothing();
	}

	// A couple of jobs in-flight/terminal across the org for the Jobs list spectrum.
	const first = seeded[0];
	if (first) {
		await db
			.insert(jobs)
			.values({ id: ctx.id("job:queued"), user_id: ownerId, org_id: orgId, project_id: first.projectId, environment_id: first.envs[0].envId, job_type: "PLAN", provider: first.project.provider, status: "QUEUED", config_snapshot: {}, created_at: minsAgo(2) })
			.onConflictDoNothing();
		await db
			.insert(jobs)
			.values({ id: ctx.id("job:processing"), user_id: ownerId, org_id: orgId, project_id: first.projectId, environment_id: first.envs[0].envId, job_type: "AUDIT", provider: first.project.provider, status: "PROCESSING", config_snapshot: {}, claimed_at: minsAgo(4), started_at: minsAgo(4) })
			.onConflictDoNothing();
	}
}

async function insertLogs(db: Db, jobId: string, lines: string[]): Promise<void> {
	if (lines.length === 0) return;
	await db.insert(jobLogs).values(lines.map((l) => ({ job_id: jobId, log_chunk: l, stream_type: "STDOUT" as const }))).onConflictDoNothing();
}

/** Runner releases, a mixed runner fleet, warm pools, usage sessions, fleet ledger. */
export async function seedFleet(ctx: SeedCtx): Promise<void> {
	const { db, orgId, now } = ctx;
	const f = fleetIds(ctx.id);

	await db.insert(runnerReleases).values({ id: f.releases[0], version: "1.9.0", release_notes: "Keyless per-job OIDC; faster plan caching.", is_breaking: false }).onConflictDoNothing();
	await db.insert(runnerReleases).values({ id: f.releases[1], version: "1.8.4", release_notes: "Drift scheduler hardening.", is_breaking: false }).onConflictDoNothing();

	const recent = new Date(now.getTime() - 40 * 1000);
	const runnerRows = [
		{ id: f.runners[0], name: "demo-runner-eu-1", operator: "managed" as const, providers: ["aws" as const], location: "fsn1", status: "ONLINE" as const, release: f.releases[0], version: "1.9.0", heartbeat: recent },
		{ id: f.runners[1], name: "demo-runner-eu-2", operator: "managed" as const, providers: ["aws" as const, "gcp" as const], location: "fsn1", status: "ONLINE" as const, release: f.releases[0], version: "1.9.0", heartbeat: recent },
		{ id: f.runners[2], name: "demo-runner-us-1", operator: "managed" as const, providers: ["gcp" as const], location: "ash", status: "DRAINING" as const, release: f.releases[1], version: "1.8.4", heartbeat: new Date(now.getTime() - 5 * 60 * 1000) },
		{ id: f.runners[3], name: "demo-runner-hetzner-1", operator: "self" as const, providers: ["hetzner" as const], location: "nbg1", status: "ONLINE" as const, release: f.releases[0], version: "1.9.0", heartbeat: recent },
	];
	for (const r of runnerRows) {
		await db
			.insert(runners)
			.values({ id: r.id, user_id: r.operator === "self" ? ctx.ownerId : null, org_id: r.operator === "self" ? orgId : null, name: r.name, operator: r.operator, provisioning: r.operator === "self" ? "registered" : undefined, supported_providers: r.providers, token_hash: `demo-${r.id}`, status: r.status, last_heartbeat: r.heartbeat, version: r.version, release_id: r.release, location: r.location })
			.onConflictDoNothing();
	}

	await db.insert(fleetPools).values({ id: f.pools[0], provider: "aws", name: "aws-eu", warm_min: 2, max: 8, enabled: true, locations: ["fsn1"] }).onConflictDoNothing();
	await db.insert(fleetPools).values({ id: f.pools[1], provider: "hetzner", name: "hetzner-nbg", warm_min: 1, max: 4, enabled: true, locations: ["nbg1"] }).onConflictDoNothing();

	await db.insert(runnerUsageSessions).values({ id: ctx.id("usage:1"), runner_id: f.runners[0], operator: "managed", org_id: orgId, started_at: new Date(now.getTime() - 3 * 3600 * 1000), ended_at: new Date(now.getTime() - 2.8 * 3600 * 1000), duration_seconds: 720 }).onConflictDoNothing();
	await db.insert(fleetActions).values({ id: f.actions[0], provider: "aws", action: "create", runner_id: f.runners[0], count: 1, reason: "warm pool below floor" }).onConflictDoNothing();
	await db.insert(fleetActions).values({ id: f.actions[1], provider: "aws", action: "drain", runner_id: f.runners[2], count: 1, reason: "rollout to 1.9.0" }).onConflictDoNothing();
}

/** Deletes all data for a demo-marked org (safety: caller verifies the marker). */
export async function teardownOrg(db: Db, orgId: string, id: (name: string) => string): Promise<void> {
	const f = fleetIds(id);
	await db.delete(jobs).where(eq(jobs.org_id, orgId)); // cascades job_logs
	await db.delete(projects).where(eq(projects.org_id, orgId)); // cascades envs, components, drift/security/cost, audit, changes
	await db.delete(resourceHierarchy).where(eq(resourceHierarchy.parent_id, orgId));
	await db.delete(cloudIdentities).where(eq(cloudIdentities.org_id, orgId));
	await db.delete(runnerUsageSessions).where(eq(runnerUsageSessions.org_id, orgId));
	await db.delete(runners).where(inArray(runners.id, f.runners));
	await db.delete(fleetActions).where(inArray(fleetActions.id, f.actions));
	await db.delete(fleetPools).where(inArray(fleetPools.id, f.pools));
	await db.delete(runnerReleases).where(inArray(runnerReleases.id, f.releases));
	await db.delete(member).where(eq(member.organizationId, orgId));
	await db.delete(team).where(eq(team.organizationId, orgId)); // cascades team_member
	await db.delete(organizationBilling).where(eq(organizationBilling.organizationId, orgId));
	await db.delete(organization).where(eq(organization.id, orgId));
}

export { makeIds };
