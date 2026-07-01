// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { tool } from "ai";
import { z } from "zod";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { getCloudIdentityInventory } from "@/app/server/actions/cloud-resources";
import { getClusters } from "@/app/server/actions/clusters";
import { getConnectorsWithStatus } from "@/app/server/actions/connectors";
import { getJob, getJobs, getPlanResult } from "@/app/server/actions/jobs";
import { getRunnersWithReleases } from "@/app/server/actions/runners";
import { getProject, getProjects } from "@/app/server/actions/projects";

const names = (a: Array<{ name: string }> | undefined) =>
	(a ?? []).map((x) => x.name);

/**
 * Read tools — each wraps an existing PDP-gated server action (the actor was
 * already authorized by the route; the actions re-check their own verb). Returns
 * are TRIMMED and SECRET-FREE (never argocd passwords, tokens, or credentials).
 */
export function readTools() {
	return {
		get_project: tool({
			description:
				"Get one project's full configuration (components + sizes) by id. PDP-gated read.",
			inputSchema: z.object({ projectId: z.string() }),
			execute: async ({ projectId }) => {
				const { project, cloudProvider, components } = await getProject(projectId);
				const c = components.cluster;
				const n = components.network;
				return {
					id: project.id,
					name: project.project_name,
					status: project.status,
					region: project.region,
					provider: cloudProvider,
					environment: project.environment_stage,
					components: {
						cluster: c
							? {
									version: c.cluster_version,
									instance_types: c.instance_types,
									node_min: c.node_min_size,
									node_desired: c.node_desired_size,
									node_max: c.node_max_size,
								}
							: null,
						network: n
							? {
									provision: n.provision_network,
									cidr: n.cidr_block,
									single_nat: n.single_nat_gateway,
								}
							: null,
						dns_enabled: components.dns?.enabled ?? false,
						databases: (components.databases ?? []).map((d) => ({
							name: d.name,
							engine: d.engine,
						})),
						caches: (components.caches ?? []).map((ch) => ({
							name: ch.name,
							engine: ch.engine,
						})),
						queues: names(components.queues),
						topics: names(components.topics),
						nosql: names(components.nosql_tables),
						secrets: names(components.secrets),
					},
				};
			},
		}),

		list_projects: tool({
			description:
				"List the user's projects (projects), flat under the org, with cloud provider, region, and status. PDP-gated read.",
			inputSchema: z.object({}),
			execute: async () => {
				const projects = await getProjects();
				return {
					projects: projects.map((p) => ({
						id: p.id,
						name: p.project_name,
						slug: p.slug,
						status: p.status,
						provider: p.cloud_provider,
						region: p.region,
						environment: p.environment_stage,
					})),
				};
			},
		}),

		list_jobs: tool({
			description:
				"List recent provisioning jobs (plan/deploy/destroy/…) with status. PDP-gated read.",
			inputSchema: z.object({
				limit: z.number().int().positive().max(50).optional(),
			}),
			execute: async ({ limit }) => {
				const all = await getJobs();
				return {
					jobs: all.slice(0, limit ?? 20).map((j) => ({
						id: j.id,
						type: j.job_type,
						status: j.status,
						project: j.project_name,
						provider: j.cloud_provider,
						created_at: j.created_at,
						completed_at: j.completed_at,
					})),
				};
			},
		}),

		get_job: tool({
			description: "Get one job's status + error by id. PDP-gated read.",
			inputSchema: z.object({ jobId: z.string() }),
			execute: async ({ jobId }) => {
				const j = await getJob(jobId);
				if (!j) return { error: "Job not found." };
				return {
					id: j.id,
					type: j.job_type,
					status: j.status,
					error: j.error_message,
					project_id: j.project_id,
					created_at: j.created_at,
					completed_at: j.completed_at,
				};
			},
		}),

		get_plan_result: tool({
			description:
				"Get a plan/deploy job's result: status, error, and the available output keys. PDP-gated read.",
			inputSchema: z.object({ jobId: z.string() }),
			execute: async ({ jobId }) => {
				const r = await getPlanResult(jobId);
				const meta = r.execution_metadata;
				return {
					status: r.status,
					error: r.error_message,
					output_keys: Object.keys(meta ?? {}),
					// The elench verification gate verdict + per-control report for this plan
					// (null until a PLAN job with the verify stage completes). Surfaced so the
					// assistant can present the proof before a deploy is approved.
					verify_verdict: meta?.verify_result?.verdict ?? null,
					verify_result: meta?.verify_result ?? null,
				};
			},
		}),

		list_runners: tool({
			description:
				"List the user's runners (execution agents) and their status/version. PDP-gated read.",
			inputSchema: z.object({}),
			execute: async () => {
				const runners = await getRunnersWithReleases();
				return {
					runners: runners.map((r) => ({
						id: r.id,
						name: r.name,
						operator: r.operator,
						status: r.status,
						version: r.version,
						online: r.status === "ONLINE",
					})),
				};
			},
		}),

		list_clusters: tool({
			description:
				"List provisioned/live clusters with endpoints, databases, and caches (no secrets). PDP-gated read.",
			inputSchema: z.object({}),
			execute: async () => {
				const clusters = await getClusters();
				return {
					clusters: clusters.map((c) => ({
						id: c.id,
						name: c.project_name,
						region: c.region,
						environment: c.environment_stage,
						status: c.status,
						provider: c.cloud_identities?.provider ?? null,
						cluster: c.project_cluster
							? {
									name: c.project_cluster.cluster_name,
									endpoint: c.project_cluster.cluster_endpoint,
									version: c.project_cluster.cluster_version,
									argocd_url: c.project_cluster.argocd_url,
									status: c.project_cluster.status,
								}
							: null,
						databases: (c.project_databases ?? []).map((d) => ({
							name: d.name,
							engine: d.engine,
							endpoint: d.endpoint,
						})),
						caches: (c.project_caches ?? []).map((ch) => ({
							name: ch.name,
							engine: ch.engine,
						})),
						dns: c.project_dns
							? { domain: c.project_dns.domain_name, enabled: c.project_dns.enabled }
							: null,
					})),
				};
			},
		}),

		list_connectors: tool({
			description:
				"List pluggable provider connectors (dns/secrets/registry/observability/git/cloud) and whether the user has connected each. PDP-gated read.",
			inputSchema: z.object({}),
			execute: async () => {
				const connectors = await getConnectorsWithStatus();
				return {
					connectors: connectors.map((c) => ({
						slug: c.slug,
						name: c.name,
						category: c.category,
						status: c.status,
						connected: c.connected,
						token_health: c.token_health,
					})),
				};
			},
		}),

		list_cloud_identities: tool({
			description:
				"List the user's VERIFIED cloud accounts (id, name, displayId, provider). Pick one before composing a stack; its provider determines valid service options.",
			inputSchema: z.object({}),
			execute: async () => ({ identities: await getVerifiedCloudIdentities() }),
		}),

		get_cached_resources: tool({
			description:
				"Get a cloud account's LIVE existing resources (VPCs/subnets/regions) from the asset inventory so you can suggest reusing a VPC or avoid CIDR clashes. PDP-gated read; never returns credentials.",
			inputSchema: z.object({ cloudIdentityId: z.string() }),
			execute: async ({ cloudIdentityId }) =>
				getCloudIdentityInventory(cloudIdentityId),
		}),
	};
}
