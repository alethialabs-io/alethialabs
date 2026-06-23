// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { tool } from "ai";
import { z } from "zod";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { getCloudIdentityResources } from "@/app/server/actions/cloud-resources";
import { getClusters } from "@/app/server/actions/clusters";
import { getConnectorsWithStatus } from "@/app/server/actions/connectors";
import { getJob, getJobs, getPlanResult } from "@/app/server/actions/jobs";
import { getRunnersWithReleases } from "@/app/server/actions/runners";
import { getSpec, getSpecs } from "@/app/server/actions/specs";
import { getZones } from "@/app/server/actions/zones";

const names = (a: Array<{ name: string }> | undefined) =>
	(a ?? []).map((x) => x.name);

/**
 * Read tools — each wraps an existing PDP-gated server action (the actor was
 * already authorized by the route; the actions re-check their own verb). Returns
 * are TRIMMED and SECRET-FREE (never argocd passwords, tokens, or credentials).
 */
export function readTools() {
	return {
		list_specs: tool({
			description:
				"List the user's infrastructure specs (id, name, status, region). PDP-gated read.",
			inputSchema: z.object({}),
			execute: async () => {
				const { specs } = await getSpecs();
				return {
					specs: specs.map((s) => ({
						id: s.id,
						name: s.project_name,
						status: s.status,
						environment: s.environment_stage,
						region: s.region,
						zone_id: s.zone_id,
					})),
				};
			},
		}),

		get_spec: tool({
			description:
				"Get one spec's full configuration (components + sizes) by id. PDP-gated read.",
			inputSchema: z.object({ specId: z.string() }),
			execute: async ({ specId }) => {
				const { spec, cloudProvider, components } = await getSpec(specId);
				const c = components.cluster;
				const n = components.network;
				return {
					id: spec.id,
					name: spec.project_name,
					status: spec.status,
					region: spec.region,
					provider: cloudProvider,
					environment: spec.environment_stage,
					zone_id: spec.zone_id,
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

		list_zones: tool({
			description:
				"List the user's zones (workspaces) and the specs in each. PDP-gated read.",
			inputSchema: z.object({}),
			execute: async () => {
				const { zones } = await getZones();
				return {
					zones: zones.map((z) => ({
						id: z.id,
						name: z.name,
						description: z.description,
						specs: (z.specs ?? []).map((s) => ({
							id: s.id,
							name: s.project_name,
							status: s.status,
						})),
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
						spec: j.spec_name,
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
					spec_id: j.spec_id,
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
				return {
					status: r.status,
					error: r.error_message,
					output_keys: Object.keys(r.execution_metadata ?? {}),
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
						cluster: c.spec_cluster
							? {
									name: c.spec_cluster.cluster_name,
									endpoint: c.spec_cluster.cluster_endpoint,
									version: c.spec_cluster.cluster_version,
									argocd_url: c.spec_cluster.argocd_url,
									status: c.spec_cluster.status,
								}
							: null,
						databases: (c.spec_databases ?? []).map((d) => ({
							name: d.name,
							engine: d.engine,
							endpoint: d.endpoint,
						})),
						caches: (c.spec_caches ?? []).map((ch) => ({
							name: ch.name,
							engine: ch.engine,
						})),
						dns: c.spec_dns
							? { domain: c.spec_dns.domain_name, enabled: c.spec_dns.enabled }
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
				"Get a cloud account's last-discovered EXISTING resources (VPCs/subnets/regions) so you can suggest reusing a VPC or avoid CIDR clashes. PDP-gated read; never returns credentials.",
			inputSchema: z.object({ cloudIdentityId: z.string() }),
			execute: async ({ cloudIdentityId }) =>
				getCloudIdentityResources(cloudIdentityId),
		}),
	};
}
