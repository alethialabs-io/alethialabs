// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { slugify } from "@/lib/slug";
import {
	projectCaches,
	projectCluster,
	projectDatabases,
	projectDns,
	projectNetwork,
	projectNosqlTables,
	projectQueues,
	projectRepositories,
	projectSecrets,
	projectSourceRepos,
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
const databasesInsert = createInsertSchema(projectDatabases);
const cachesInsert = createInsertSchema(projectCaches);
const queuesInsert = createInsertSchema(projectQueues);
const topicsInsert = createInsertSchema(projectTopics, {
	subscriptions: z.custom<TopicSubscription[]>().optional(),
});
const nosqlInsert = createInsertSchema(projectNosqlTables, {
	provider_config: z.custom<NosqlProviderConfig>().optional(),
});
const secretsInsert = createInsertSchema(projectSecrets);

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
});

export type ProjectFormData = z.infer<typeof projectFormSchema>;
export type ProjectFormInput = z.input<typeof projectFormSchema>;

export {
	databaseItemSchema,
	cacheItemSchema,
	queueItemSchema,
	topicItemSchema,
	nosqlItemSchema,
	secretItemSchema,
	sourceRepoItemSchema,
	// Singleton sub-schemas — consumed by the canvas for per-node validation.
	projectSchema,
	networkSchema,
	clusterSchema,
	dnsSchema,
	repositoriesSchema,
};
