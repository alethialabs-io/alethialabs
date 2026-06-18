// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { pgEnum } from "drizzle-orm/pg-core";

// Postgres enums in active use. (The generated Supabase types also list dead
// enums from dropped tables — cluster_status, deployment_*, iac_tool, logs_level
// — which are intentionally omitted.)

export const cloudProvider = pgEnum("cloud_provider", ["aws", "azure", "gcp"]);

export const logStreamType = pgEnum("log_stream_type", [
	"STDOUT",
	"STDERR",
	"SYSTEM",
]);

export const environmentStage = pgEnum("environment_stage", [
	"development",
	"staging",
	"production",
]);

export const specStatus = pgEnum("spec_status", [
	"DRAFT",
	"QUEUED",
	"PROVISIONING",
	"ACTIVE",
	"FAILED",
	"DESTROYING",
	"DESTROYED",
]);

export const componentStatus = pgEnum("component_status", [
	"PENDING",
	"CREATING",
	"ACTIVE",
	"UPDATING",
	"FAILED",
	"DESTROYING",
	"DESTROYED",
]);

export const cacheEngine = pgEnum("cache_engine", ["redis", "valkey"]);

export const nosqlTableType = pgEnum("nosql_table_type", ["standard", "global"]);
export const nosqlKeyType = pgEnum("nosql_key_type", ["S", "N", "B"]);
export const nosqlBillingMode = pgEnum("nosql_billing_mode", [
	"PAY_PER_REQUEST",
	"PROVISIONED",
]);

export const registryTagMutability = pgEnum("registry_tag_mutability", [
	"MUTABLE",
	"IMMUTABLE",
]);

export const gitCredentialPurpose = pgEnum("git_credential_purpose", [
	"argocd",
	"applications",
	"infrastructure",
]);
export const gitCredentialMethod = pgEnum("git_credential_method", [
	"oauth",
	"pat",
	"deploy_key",
]);
export const gitProvider = pgEnum("git_provider", [
	"github",
	"bitbucket",
	"gitlab",
]);

export const auditAction = pgEnum("audit_action", [
	"CREATED",
	"UPDATED",
	"DELETED",
	"PROVISIONED",
	"DESTROYED",
	"COMPONENT_ADDED",
	"COMPONENT_UPDATED",
	"COMPONENT_REMOVED",
	"STATUS_CHANGED",
]);

export const provisionJobStatus = pgEnum("provision_job_status", [
	"QUEUED",
	"CLAIMED",
	"PROCESSING",
	"SUCCESS",
	"FAILED",
	"CANCELLED",
]);
export const provisionJobType = pgEnum("provision_job_type", [
	"DESTROY_WORKER",
	"DEPLOY",
	"DESTROY",
	"CONNECTION_TEST",
	"FETCH_RESOURCES",
	"PLAN",
	"DEPLOY_WORKER",
	"UPDATE_WORKER",
]);

export const workerMode = pgEnum("worker_mode", ["self-hosted", "cloud-hosted"]);
export const workerStatus = pgEnum("worker_status", [
	"ONLINE",
	"OFFLINE",
	"DRAINING",
]);

export const connectorCategory = pgEnum("connector_category", [
	"git",
	"cloud",
	"observability",
	"registry",
	"dns",
	"secrets",
]);
export const connectorAuthMethod = pgEnum("connector_auth_method", [
	"oauth",
	"iam_role",
	"service_account",
	"service_principal",
	"ram_role",
	"api_key",
]);
export const connectorStatus = pgEnum("connector_status", [
	"active",
	"coming_soon",
]);

// TS unions derived from the pg enums — the Drizzle-native replacement for the
// supazod-generated `Public*` enum types. Use these everywhere app code needs the
// string-literal union of an enum's values.
export type CloudProvider = (typeof cloudProvider.enumValues)[number];
export type GitProvider = (typeof gitProvider.enumValues)[number];
export type ProvisionJobType = (typeof provisionJobType.enumValues)[number];
export type ProvisionJobStatus = (typeof provisionJobStatus.enumValues)[number];
export type WorkerMode = (typeof workerMode.enumValues)[number];
export type WorkerStatus = (typeof workerStatus.enumValues)[number];
export type SpecStatus = (typeof specStatus.enumValues)[number];
export type ComponentStatus = (typeof componentStatus.enumValues)[number];
export type EnvironmentStage = (typeof environmentStage.enumValues)[number];
export type CacheEngine = (typeof cacheEngine.enumValues)[number];
export type LogStreamType = (typeof logStreamType.enumValues)[number];
