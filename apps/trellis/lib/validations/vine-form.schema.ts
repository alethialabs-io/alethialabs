import { z } from "zod";
import {
	publicVinesInsertSchema,
	publicVineNetworkInsertSchema,
	publicVineClusterInsertSchema,
	publicVineDnsInsertSchema,
	publicVineRepositoriesInsertSchema,
	publicVineDatabasesInsertSchema,
	publicVineCachesInsertSchema,
	publicVineQueuesInsertSchema,
	publicVineTopicsInsertSchema,
	publicVineNosqlTablesInsertSchema,
	publicVineSecretsInsertSchema,
} from "./database.schemas";

const autoFields = { id: true, created_at: true, updated_at: true } as const;
const componentAutoFields = {
	...autoFields,
	vine_id: true,
	status: true,
	status_message: true,
	estimated_monthly_cost: true,
} as const;

const vineSchema = publicVinesInsertSchema
	.omit({
		...autoFields,
		user_id: true,
		status: true,
		estimated_monthly_cost: true,
	})
	.extend({
		project_name: z.string().min(1, "Vine name is required").max(25).regex(/^[a-z0-9][a-z0-9-]*$/, "Lowercase, numbers, hyphens only"),
		vineyard_id: z.string().min(1, "Vineyard is required"),
		region: z.string().min(1, "Region is required"),
		cloud_identity_id: z.string().min(1, "Cloud account is required"),
	});

const networkSchema = publicVineNetworkInsertSchema.omit(componentAutoFields);

const clusterSchema = publicVineClusterInsertSchema.omit({
	...componentAutoFields,
	cluster_name: true,
	cluster_endpoint: true,
});

const dnsSchema = publicVineDnsInsertSchema.omit(componentAutoFields);

const repositoriesSchema = publicVineRepositoriesInsertSchema.omit({
	...autoFields,
	vine_id: true,
});

const databaseItemSchema = publicVineDatabasesInsertSchema.omit({
	...componentAutoFields,
	endpoint: true,
	reader_endpoint: true,
}).extend({ name: z.string().min(1, "Database name is required") });

const cacheItemSchema = publicVineCachesInsertSchema.omit({
	...componentAutoFields,
	endpoint: true,
}).extend({ name: z.string().min(1, "Cache name is required") });

const queueItemSchema = publicVineQueuesInsertSchema
	.omit(componentAutoFields)
	.extend({ name: z.string().min(1, "Queue name is required") });

const topicItemSchema = publicVineTopicsInsertSchema
	.omit(componentAutoFields)
	.extend({ name: z.string().min(1, "Topic name is required") });

const nosqlItemSchema = publicVineNosqlTablesInsertSchema
	.omit(componentAutoFields)
	.extend({
		name: z.string().min(1, "Table name is required"),
		hash_key: z.string().min(1, "Hash key is required"),
	});

const secretItemSchema = publicVineSecretsInsertSchema.omit({
	...autoFields,
	vine_id: true,
	status: true,
	status_message: true,
}).extend({ name: z.string().min(1, "Secret name is required") });

export const vineFormSchema = z.object({
	vine: vineSchema,
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

export type VineFormData = z.infer<typeof vineFormSchema>;

export {
	databaseItemSchema,
	cacheItemSchema,
	queueItemSchema,
	topicItemSchema,
	nosqlItemSchema,
	secretItemSchema,
};
