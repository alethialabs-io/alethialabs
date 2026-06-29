// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { pgEnum } from "drizzle-orm/pg-core";

// Postgres enums in active use. (Some dropped tables left dead enums in the DB — cluster_status, deployment_*, iac_tool, logs_level
// — which are intentionally omitted.)

export const cloudProvider = pgEnum("cloud_provider", [
	"aws",
	"azure",
	"gcp",
	"alibaba",
	"digitalocean",
	"hetzner",
	"civo",
]);

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

export const projectStatus = pgEnum("project_status", [
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
	"ANALYZE_REPO",
]);

export const runnerMode = pgEnum("runner_mode", ["self-hosted", "cloud-hosted"]);
// Who operates & bills a runner. `managed` = Alethia runs it in our account and
// bills it by provisioned hours (platform-owned, no user); `self` = the customer
// runs it. Replaces the location-flavoured `runner_mode`.
export const runnerOperator = pgEnum("runner_operator", ["managed", "self"]);
// How a self-operated runner came to exist. `deployed` = provisioned into the
// customer's cloud by an existing runner running Terraform (the "Deploy" flow);
// `registered` = the customer brought their own (own Terraform or
// `alethia runner start`) and registered it. Null for `managed` runners.
export const runnerProvisioning = pgEnum("runner_provisioning", [
	"deployed",
	"registered",
]);
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

// Visibility/ownership of a stored credential (cloud_identities / connector_credentials).
// `personal` = author-only (the creating user); `org` = shared with the whole org, access
// governed by the PDP connector/cloud_identity grants + roles. See dataroom/spec/mvp/08 + 07.
export const credentialScope = pgEnum("credential_scope", ["personal", "org"]);

// Lifecycle of a cloud_identity's connection: just created (no creds yet), a
// CONNECTION_TEST is in flight, the test passed (connected), or it failed. Drives
// the connectors page health treatment + the verification finalize.
export const cloudIdentityStatus = pgEnum("cloud_identity_status", [
	"pending",
	"testing",
	"connected",
	"failed",
]);

// Alerting (dataroom/spec/mvp/25-alerting-notifications.md). Delivery channels, event
// sources, severity, and the deliveries-ledger lifecycle.
export const alertChannelType = pgEnum("alert_channel_type", [
	"webhook",
	"email",
	"slack",
	"rocketchat",
	"discord",
	"teams",
	"mattermost",
	"googlechat",
	"pagerduty",
]);
// Event keys are TEXT, not a DB enum — the catalog is code-derived from the PDP
// registry (lib/alerts/catalog.ts) so a new alertable action/event is code-only.
export const alertSeverity = pgEnum("alert_severity", [
	"info",
	"warning",
	"critical",
]);
export const alertDeliveryStatus = pgEnum("alert_delivery_status", [
	"pending",
	"sent",
	"failed",
	"dead",
]);

// Durable connector-credential health (dataroom/spec/mvp/25 Phase 3): which credential family,
// and its last point-of-use outcome. Drives the `system.connector.token_failed` alert.
export const connectorHealthKind = pgEnum("connector_health_kind", [
	"git",
	"api_key",
]);
export const connectorHealthStatus = pgEnum("connector_health_status", [
	"healthy",
	"failed",
]);

// Billing plan an organization is subscribed to. Drives entitlements via the
// granular ladder in lib/billing/plan.ts (community → all off; team → orgs/teams;
// enterprise → + custom roles + activity export + SSO). `community` is also the
// implicit plan for any org with no billing row.
export const billingPlan = pgEnum("billing_plan", [
	"community",
	"team",
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
export type RunnerOperator = (typeof runnerOperator.enumValues)[number];
export type RunnerProvisioning = (typeof runnerProvisioning.enumValues)[number];
export type RunnerStatus = (typeof runnerStatus.enumValues)[number];
export type ProjectStatus = (typeof projectStatus.enumValues)[number];
export type ComponentStatus = (typeof componentStatus.enumValues)[number];
export type EnvironmentStage = (typeof environmentStage.enumValues)[number];
export type CacheEngine = (typeof cacheEngine.enumValues)[number];
export type LogStreamType = (typeof logStreamType.enumValues)[number];
export type BillingPlan = (typeof billingPlan.enumValues)[number];
export type BillingStatus = (typeof billingStatus.enumValues)[number];
export type AlertChannelType = (typeof alertChannelType.enumValues)[number];
export type AlertSeverity = (typeof alertSeverity.enumValues)[number];
export type CredentialScope = (typeof credentialScope.enumValues)[number];
export type CloudIdentityStatus =
	(typeof cloudIdentityStatus.enumValues)[number];
export type ConnectorHealthKind =
	(typeof connectorHealthKind.enumValues)[number];
export type ConnectorHealthStatus =
	(typeof connectorHealthStatus.enumValues)[number];
export type AlertDeliveryStatus =
	(typeof alertDeliveryStatus.enumValues)[number];
