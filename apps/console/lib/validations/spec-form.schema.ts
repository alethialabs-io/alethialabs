// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import {
	specCaches,
	specCluster,
	specDatabases,
	specDns,
	specNetwork,
	specNosqlTables,
	specQueues,
	specRepositories,
	specSecrets,
	specTopics,
	specs,
} from "@/lib/db/schema";
import type {
	ClusterAdmin,
	ClusterProviderConfig,
	DnsProviderConfig,
	NosqlProviderConfig,
	TopicSubscription,
} from "@/types/database-custom.types";

// Insert schemas derived from the Drizzle tables (drizzle-zod) — the replacement
// for the retired supazod `public*InsertSchema` schemas. JSONB columns get their
// typed shapes back via z.custom refinements (drizzle-zod emits z.unknown()
// otherwise) so SpecFormData keeps the same field types the form components rely on.
const specsInsert = createInsertSchema(specs);
const networkInsert = createInsertSchema(specNetwork);
const clusterInsert = createInsertSchema(specCluster, {
	cluster_admins: z.custom<ClusterAdmin[]>().optional(),
	provider_config: z.custom<ClusterProviderConfig>().optional(),
});
const dnsInsert = createInsertSchema(specDns, {
	provider_config: z.custom<DnsProviderConfig>().optional(),
});
const repositoriesInsert = createInsertSchema(specRepositories);
const databasesInsert = createInsertSchema(specDatabases);
const cachesInsert = createInsertSchema(specCaches);
const queuesInsert = createInsertSchema(specQueues);
const topicsInsert = createInsertSchema(specTopics, {
	subscriptions: z.custom<TopicSubscription[]>().optional(),
});
const nosqlInsert = createInsertSchema(specNosqlTables, {
	provider_config: z.custom<NosqlProviderConfig>().optional(),
});
const secretsInsert = createInsertSchema(specSecrets);

const autoFields = { id: true, created_at: true, updated_at: true } as const;
const componentAutoFields = {
	...autoFields,
	spec_id: true,
	status: true,
	status_message: true,
	estimated_monthly_cost: true,
} as const;

const specSchema = specsInsert
	.omit({
		...autoFields,
		user_id: true,
		zone_id: true,
		status: true,
		estimated_monthly_cost: true,
	})
	.extend({
		project_name: z.string().min(1, "Spec name is required").max(25).regex(/^[a-z0-9][a-z0-9-]*$/, "Lowercase, numbers, hyphens only"),
		zone_id: z.string().min(1, "Zone is required"),
		region: z.string().min(1, "Region is required"),
		cloud_identity_id: z.string().min(1, "Cloud account is required"),
		container_platform: z.string().optional(),
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
	spec_id: true,
});

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
	spec_id: true,
	status: true,
	status_message: true,
}).extend({ name: z.string().min(1, "Secret name is required") });

export const specFormSchema = z.object({
	spec: specSchema,
	network: networkSchema,
	cluster: clusterSchema,
	dns: dnsSchema,
	repositories: repositoriesSchema,
	databases: z.array(databaseItemSchema).default([]),
	caches: z.array(cacheItemSchema).default([]),
	queues: z.array(queueItemSchema).default([]),
	topics: z.array(topicItemSchema).default([]),
	nosql_tables: z.array(nosqlItemSchema).default([]),
	secrets: z.array(secretItemSchema).default([]),
});

export type SpecFormData = z.infer<typeof specFormSchema>;
export type SpecFormInput = z.input<typeof specFormSchema>;

export {
	databaseItemSchema,
	cacheItemSchema,
	queueItemSchema,
	topicItemSchema,
	nosqlItemSchema,
	secretItemSchema,
};
