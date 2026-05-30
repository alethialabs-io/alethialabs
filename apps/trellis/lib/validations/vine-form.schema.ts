import { z } from "zod";
import {
	publicVinesInsertSchema,
	publicVineVpcInsertSchema,
	publicVineEksInsertSchema,
	publicVineDnsInsertSchema,
	publicVineRepositoriesInsertSchema,
	publicVineDatabasesInsertSchema,
	publicVineCachesInsertSchema,
	publicVineQueuesInsertSchema,
	publicVineTopicsInsertSchema,
	publicVineDynamodbTablesInsertSchema,
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
		aws_region: z.string().min(1, "Region is required"),
		cloud_identity_id: z.string().min(1, "AWS account is required"),
	});

const vpcSchema = publicVineVpcInsertSchema.omit(componentAutoFields);

const eksSchema = publicVineEksInsertSchema.omit({
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
});

const cacheItemSchema = publicVineCachesInsertSchema.omit({
	...componentAutoFields,
	endpoint: true,
});

const queueItemSchema = publicVineQueuesInsertSchema.omit(componentAutoFields);

const topicItemSchema = publicVineTopicsInsertSchema.omit(componentAutoFields);

const dynamodbItemSchema = publicVineDynamodbTablesInsertSchema.omit(componentAutoFields);

const secretItemSchema = publicVineSecretsInsertSchema.omit({
	...autoFields,
	vine_id: true,
	status: true,
	status_message: true,
});

export const vineFormSchema = z.object({
	vine: vineSchema,
	vpc: vpcSchema,
	eks: eksSchema,
	dns: dnsSchema,
	repositories: repositoriesSchema,
	databases: z.array(databaseItemSchema).default([]),
	caches: z.array(cacheItemSchema).default([]),
	queues: z.array(queueItemSchema).default([]),
	topics: z.array(topicItemSchema).default([]),
	dynamodb_tables: z.array(dynamodbItemSchema).default([]),
	secrets: z.array(secretItemSchema).default([]),
});

export type VineFormData = z.infer<typeof vineFormSchema>;

export {
	databaseItemSchema,
	cacheItemSchema,
	queueItemSchema,
	topicItemSchema,
	dynamodbItemSchema,
	secretItemSchema,
};
