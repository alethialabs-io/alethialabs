// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { pgEnum } from "drizzle-orm/pg-core";

// Postgres enums in active use. (Some dropped tables left dead enums in the DB — cluster_status, deployment_*, iac_tool, logs_level
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
// Cloud-neutral capacity mode; mappers translate to the provider value
// (AWS DynamoDB PAY_PER_REQUEST/PROVISIONED, etc.) at provision time.
export const nosqlCapacityMode = pgEnum("nosql_capacity_mode", [
	"on_demand",
	"provisioned",
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
	"DESTROY_RUNNER",
	"DEPLOY",
	"DESTROY",
	"CONNECTION_TEST",
	"FETCH_RESOURCES",
	"PLAN",
	"DEPLOY_RUNNER",
	"UPDATE_RUNNER",
]);

export const runnerMode = pgEnum("runner_mode", ["self-hosted", "cloud-hosted"]);
export const runnerStatus = pgEnum("runner_status", [
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

// Billing plan an organization is subscribed to. Drives entitlements via the
// granular ladder in lib/billing/plan.ts (community → all off; team → orgs/teams;
// business → + custom roles + audit export; enterprise → + SSO). `community` is
// also the implicit plan for any org with no billing row.
export const billingPlan = pgEnum("billing_plan", [
	"community",
	"team",
	"business",
	"enterprise",
]);
// Subscription lifecycle state (mirrors Stripe). Only `trialing`/`active` grant the
// plan's paid entitlements; anything else falls back to the community baseline.
export const billingStatus = pgEnum("billing_status", [
	"none",
	"trialing",
	"active",
	"past_due",
	"canceled",
]);

// TS unions derived from the pg enums — the Drizzle-native replacement for the
// supazod-generated `Public*` enum types. Use these everywhere app code needs the
// string-literal union of an enum's values.
export type CloudProvider = (typeof cloudProvider.enumValues)[number];
export type GitProvider = (typeof gitProvider.enumValues)[number];
export type ProvisionJobType = (typeof provisionJobType.enumValues)[number];
export type ProvisionJobStatus = (typeof provisionJobStatus.enumValues)[number];
export type RunnerMode = (typeof runnerMode.enumValues)[number];
export type RunnerStatus = (typeof runnerStatus.enumValues)[number];
export type SpecStatus = (typeof specStatus.enumValues)[number];
export type ComponentStatus = (typeof componentStatus.enumValues)[number];
export type EnvironmentStage = (typeof environmentStage.enumValues)[number];
export type CacheEngine = (typeof cacheEngine.enumValues)[number];
export type LogStreamType = (typeof logStreamType.enumValues)[number];
export type BillingPlan = (typeof billingPlan.enumValues)[number];
export type BillingStatus = (typeof billingStatus.enumValues)[number];
