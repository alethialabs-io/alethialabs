// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { slugify } from "@/lib/slug";
import {
	placementMode,
	projectCaches,
	projectCluster,
	projectContainerRegistries,
	projectDatabases,
	projectDns,
	projectNetwork,
	projectNosqlTables,
	projectQueues,
	projectRepositories,
	projectSecrets,
	projectServices,
	projectSourceRepos,
	projectStorageBuckets,
	projectTopics,
	projects,
} from "@/lib/db/schema";
import type {
	ClusterAdmin,
	ClusterProviderConfig,
	DetectedService,
	DnsProviderConfig,
	NodeSize,
	NosqlProviderConfig,
	RegistryProviderConfig,
	StorageProviderConfig,
	TopicSubscription,
} from "@/types/jsonb.types";

// Insert schemas derived from the Drizzle tables (drizzle-zod) — the replacement
// for the retired supazod `public*InsertSchema` schemas. JSONB columns get their
// typed shapes back via z.custom refinements (drizzle-zod emits z.unknown()
// otherwise) so ProjectFormData keeps the same field types the form components rely on.
const projectsInsert = createInsertSchema(projects);
const networkInsert = createInsertSchema(projectNetwork);
const clusterInsert = createInsertSchema(projectCluster, {
	cluster_admins: z.custom<ClusterAdmin[]>().optional(),
	provider_config: z.custom<ClusterProviderConfig>().optional(),
	node_size: z.custom<NodeSize>().optional(),
});
const dnsInsert = createInsertSchema(projectDns, {
	provider_config: z.custom<DnsProviderConfig>().optional(),
});
const repositoriesInsert = createInsertSchema(projectRepositories);
const sourceReposInsert = createInsertSchema(projectSourceRepos, {
	services: z.custom<DetectedService[]>().optional(),
});
// In-cluster sizing columns (compute-only clouds, e.g. Hetzner) — clamp to the
// inspector's bounds; NULL/omitted means the in-cluster mapper's defaults apply.
const databasesInsert = createInsertSchema(projectDatabases, {
	storage_gb: z.number().int().min(1).max(1024).nullable().optional(),
	replicas: z.number().int().min(1).max(5).nullable().optional(),
});
const cachesInsert = createInsertSchema(projectCaches, {
	storage_gb: z.number().int().min(1).max(512).nullable().optional(),
});
const queuesInsert = createInsertSchema(projectQueues, {
	storage_gb: z.number().int().min(1).max(256).nullable().optional(),
});
const topicsInsert = createInsertSchema(projectTopics, {
	subscriptions: z.custom<TopicSubscription[]>().optional(),
});
const nosqlInsert = createInsertSchema(projectNosqlTables, {
	provider_config: z.custom<NosqlProviderConfig>().optional(),
});
const secretsInsert = createInsertSchema(projectSecrets);
const bucketsInsert = createInsertSchema(projectStorageBuckets, {
	provider_config: z.custom<StorageProviderConfig>().optional(),
});
const registriesInsert = createInsertSchema(projectContainerRegistries, {
	provider_config: z.custom<RegistryProviderConfig>().optional(),
});

// W1 — service/workload sub-shapes (validated, not passthrough): a service is the customer's own
// code, so the form drives real config the runner turns into k8s manifests.
const serviceSourceSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("repo"),
		repo_url: z.string().min(1, "Repo URL is required"),
		path: z.string().default(""),
	}),
	z.object({ kind: z.literal("image"), image: z.string().min(1, "Image is required") }),
]);
const serviceBuildSchema = z.object({
	dockerfile: z.string().optional(),
	context: z.string().optional(),
});
// Exported for reuse by the BYO chart-workload validators (lib/validations/chart-workloads.ts),
// which describe the same env/port/resource/binding shapes read off a rendered chart.
export const serviceEnvSchema = z.object({
	name: z.string().min(1, "Env var name is required"),
	value: z.string(),
});
export const servicePortSchema = z.object({
	name: z.string().optional(),
	container_port: z.number().int().min(1).max(65535),
	protocol: z.enum(["TCP", "UDP"]).optional(),
});
const serviceQuantitySchema = z.object({ cpu: z.string(), memory: z.string() });
export const serviceResourcesSchema = z.object({
	requests: serviceQuantitySchema,
	limits: serviceQuantitySchema,
});
const serviceProbeSchema = z.object({
	type: z.enum(["http", "tcp"]),
	path: z.string().optional(),
	port: z.number().int().min(1).max(65535),
});
// W3 — a service's edge to a backing resource ({kind, name}) plus the env each connection facet
// injects. `from` distinguishes non-secret facets (endpoint/port → templated values) from
// credential facets (→ ExternalSecret secretKeyRef); the runner resolves them at deploy time.
export const serviceBindingSchema = z.object({
	target: z.object({
		kind: z.enum(["database", "cache", "queue", "secret"]),
		name: z.string().min(1, "Binding target is required"),
		// BYO-IaC target only: its Terraform address + the customer module's output names the
		// facets resolve against (#687). Absent for a first-class component; wire keys mirror the
		// Go `ServiceBindingTarget` json tags.
		address: z.string().optional(),
		output_keys: z
			.object({
				endpoint: z.string().optional(),
				port: z.string().optional(),
				credential_secret: z.string().optional(),
			})
			.optional(),
	}),
	inject: z.array(
		z.object({
			env: z.string().min(1, "Env var name is required"),
			from: z.enum([
				"endpoint",
				"port",
				"username",
				"password",
				"connection_string",
			]),
		}),
	),
});
const servicesInsert = createInsertSchema(projectServices, {
	source: serviceSourceSchema,
	build: serviceBuildSchema.nullable().optional(),
	env: z.array(serviceEnvSchema),
	ports: z.array(servicePortSchema),
	// A service with no backing-infra needs carries no bindings — optional, defaults to [] like the
	// DB column, so services authored before W3 (and every existing fixture) still parse.
	bindings: z.array(serviceBindingSchema).default([]),
	resources: serviceResourcesSchema.nullable().optional(),
	probe: serviceProbeSchema.nullable().optional(),
});

const autoFields = { id: true, created_at: true, updated_at: true } as const;
const componentAutoFields = {
	...autoFields,
	project_id: true,
	status: true,
	status_message: true,
	estimated_monthly_cost: true,
} as const;

const projectSchema = projectsInsert
	.omit({
		...autoFields,
		user_id: true,
		estimated_monthly_cost: true,
	})
	.extend({
		// Free-text display name (Vercel-style): the URL slug is derived from it via
		// `slugify` in createProject. We only require it slugifies to something non-empty.
		project_name: z
			.string()
			.min(1, "Project name is required")
			.max(50)
			.refine((v) => slugify(v).length > 0, "Enter at least one letter or number"),
		region: z.string().min(1, "Region is required"),
		cloud_identity_id: z.string().min(1, "Cloud account is required"),
		container_platform: z.string().optional(),
		// M1: environment_stage moved off the projects table; the form still captures the
		// project's INITIAL environment (createProject turns it into the default env row).
		environment_stage: z.enum(["development", "staging", "production"]),
		// The default (Production) env's placement onto its first Fabric. Optional — createProject
		// defaults it to `dedicated` (the new Fabric's owner). The placement selector (#844) sets it.
		placement_mode: z.enum(placementMode.enumValues).optional(),
	});

const networkSchema = networkInsert
	.omit(componentAutoFields)
	.superRefine((data, ctx) => {
		if (data.provision_network === false && !data.network_id) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Select a VPC when using an existing network",
				path: ["network_id"],
			});
		}
	});

const clusterSchema = clusterInsert.omit({
	...componentAutoFields,
	cluster_name: true,
	cluster_endpoint: true,
});

const dnsSchema = dnsInsert.omit(componentAutoFields);

const repositoriesSchema = repositoriesInsert.omit({
	...autoFields,
	project_id: true,
});

// One scanned source repo (or monorepo subtree) attached to the project. Multiple
// allowed (1:N) — the inference merge collects them; ArgoCD's destination stays the
// single `repositories.apps_destination_repo`.
const sourceRepoItemSchema = sourceReposInsert
	.omit({ ...autoFields, project_id: true })
	.extend({ repo_url: z.string().min(1, "Repo URL is required") });

const databaseItemSchema = databasesInsert.omit({
	...componentAutoFields,
	endpoint: true,
	reader_endpoint: true,
}).extend({ name: z.string().min(1, "Database name is required") });

const cacheItemSchema = cachesInsert.omit({
	...componentAutoFields,
	endpoint: true,
	reader_endpoint: true,
}).extend({ name: z.string().min(1, "Cache name is required") });

const queueItemSchema = queuesInsert
	.omit(componentAutoFields)
	.extend({ name: z.string().min(1, "Queue name is required") });

const topicItemSchema = topicsInsert
	.omit(componentAutoFields)
	.extend({ name: z.string().min(1, "Topic name is required") });

const nosqlItemSchema = nosqlInsert
	.omit(componentAutoFields)
	.extend({
		name: z.string().min(1, "Table name is required"),
		partition_key: z.string().min(1, "Hash key is required"),
	});

const secretItemSchema = secretsInsert.omit({
	...autoFields,
	project_id: true,
	status: true,
	status_message: true,
}).extend({ name: z.string().min(1, "Secret name is required") });

// S3-safe bucket naming (the strictest cloud rules, so one name works everywhere):
// 3–63 chars, lowercase letters / digits / hyphens, no leading or trailing hyphen.
const S3_SAFE_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;

const bucketItemSchema = bucketsInsert
	.omit(componentAutoFields)
	.extend({
		name: z
			.string()
			.min(1, "Bucket name is required")
			.refine(
				(v) => S3_SAFE_NAME.test(v),
				"3–63 lowercase letters, digits, or hyphens; must start and end with a letter or digit",
			),
	});

const registryItemSchema = registriesInsert
	.omit({
		...autoFields,
		project_id: true,
		status: true,
		status_message: true,
		// Output column (set after the first deploy), never designed by the user.
		repository_url: true,
	})
	.extend({ name: z.string().min(1, "Registry name is required") });

// W1 — a first-class service/workload the customer designs on the canvas.
const serviceItemSchema = servicesInsert
	.omit({
		...componentAutoFields,
		// Output column (the W2 build's write-back digest), never designed by the user.
		resolved_image: true,
	})
	.extend({
		name: z.string().min(1, "Service name is required"),
		type: z
			.enum(["deployment", "job", "cronjob", "statefulset"])
			.default("deployment"),
	});

export const projectFormSchema = z.object({
	project: projectSchema,
	network: networkSchema,
	cluster: clusterSchema,
	dns: dnsSchema,
	repositories: repositoriesSchema,
	source_repos: z.array(sourceRepoItemSchema).default([]),
	databases: z.array(databaseItemSchema).default([]),
	caches: z.array(cacheItemSchema).default([]),
	queues: z.array(queueItemSchema).default([]),
	topics: z.array(topicItemSchema).default([]),
	nosql_tables: z.array(nosqlItemSchema).default([]),
	secrets: z.array(secretItemSchema).default([]),
	storage_buckets: z.array(bucketItemSchema).default([]),
	container_registries: z.array(registryItemSchema).default([]),
	services: z.array(serviceItemSchema).default([]),
});

export type ProjectFormData = z.infer<typeof projectFormSchema>;
export type ProjectFormInput = z.input<typeof projectFormSchema>;

export {
	serviceItemSchema,
	databaseItemSchema,
	cacheItemSchema,
	queueItemSchema,
	topicItemSchema,
	nosqlItemSchema,
	secretItemSchema,
	bucketItemSchema,
	registryItemSchema,
	sourceRepoItemSchema,
	// Singleton sub-schemas — consumed by the canvas for per-node validation.
	projectSchema,
	networkSchema,
	clusterSchema,
	dnsSchema,
	repositoriesSchema,
};
