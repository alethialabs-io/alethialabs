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

/** Op of a staged project change (project_changes), diffed against the live config. */
export const changeOp = pgEnum("change_op", ["CREATE", "UPDATE", "DELETE"]);

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
	"PLAN",
	"DEPLOY_RUNNER",
	"UPDATE_RUNNER",
	"ANALYZE_REPO",
	"DETECT_DRIFT",
	"AUDIT",
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
	// Authenticated but missing some provisioning permissions (server-side health probe).
	"degraded",
	// Was connected, but access has since been lost (revoked role / broken trust).
	"disconnected",
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
// Status of a locally-mirrored invoice. We only ever record invoices once money has
// moved, so there is no `draft`/`open` here: `paid` is the norm, `refunded` when a
// charge is reversed, and `void` if a finalized+paid invoice is later voided.
export const invoiceStatus = pgEnum("invoice_status", [
	"paid",
	"refunded",
	"void",
]);

// Environment promotion (Phase 2). A promotion writes a source env's structural changes onto a
// target env, runs a PLAN to produce verify + cost, evaluates the target's protection gates, then
// DEPLOYs (or waits for approval). No new provision_job_type — a promotion reuses PLAN then DEPLOY.
export const promotionStatus = pgEnum("promotion_status", [
	"PENDING_PLAN", // candidate written; PLAN job queued to produce verify + cost
	"PENDING_APPROVAL", // gates need a human (manual approval or cost over threshold)
	"APPROVED", // approvals satisfied; deploy about to enqueue
	"DEPLOYING", // deploy job queued/running
	"SUCCEEDED",
	"FAILED", // plan or deploy failed
	"BLOCKED", // a hard gate failed (predecessor unhealthy / verify hard-fail)
	"CANCELLED",
]);
// A single required-approval decision on a promotion.
export const approvalStatus = pgEnum("approval_status", [
	"pending",
	"approved",
	"rejected",
]);

// Support cases (dataroom/spec: support experience). A tenant-owned help-desk case
// system: submit → track in "My cases" → converse in a per-case thread. Cases are
// org-scoped like agent_threads; staff answer via an out-of-band surface (Slack) so
// our DB stays the source of truth.
export const supportCaseType = pgEnum("support_case_type", [
	"technical",
	"billing",
	"account",
	"general",
	"abuse",
]);
// Service / area the case is about (AWS-style), used for routing + triage.
export const supportCaseCategory = pgEnum("support_case_category", [
	"clusters",
	"jobs",
	"runners",
	"connectors",
	"networking",
	"billing_invoices",
	"account_access",
	"quotas_limits",
	"api_cli",
	"agent_ai",
	"other",
]);
// low = general guidance … urgent = production impact. Drives expected-response copy.
export const supportCaseSeverity = pgEnum("support_case_severity", [
	"low",
	"normal",
	"high",
	"urgent",
]);
export const supportCaseStatus = pgEnum("support_case_status", [
	"open", // submitted, awaiting first staff response
	"pending_support", // waiting on Alethia
	"pending_customer", // waiting on the customer's reply
	"resolved", // staff (or customer) marked resolved
	"closed", // closed (by customer or auto after resolved)
]);
// Who authored a thread message. `ai` = the elench support assistant autoreply;
// `system` = status-change / automated notes.
export const supportAuthorType = pgEnum("support_author_type", [
	"customer",
	"staff",
	"system",
	"ai",
]);
// Abuse taxonomy (only when support_case_type = 'abuse').
export const supportAbuseCategory = pgEnum("support_abuse_category", [
	"phishing",
	"malware",
	"spam",
	"copyright",
	"csam",
	"other",
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
export type PromotionStatus = (typeof promotionStatus.enumValues)[number];
export type ApprovalStatus = (typeof approvalStatus.enumValues)[number];
export type CacheEngine = (typeof cacheEngine.enumValues)[number];
export type LogStreamType = (typeof logStreamType.enumValues)[number];
export type BillingPlan = (typeof billingPlan.enumValues)[number];
export type BillingStatus = (typeof billingStatus.enumValues)[number];
export type InvoiceStatus = (typeof invoiceStatus.enumValues)[number];
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
export type SupportCaseType = (typeof supportCaseType.enumValues)[number];
export type SupportCaseCategory =
	(typeof supportCaseCategory.enumValues)[number];
export type SupportCaseSeverity =
	(typeof supportCaseSeverity.enumValues)[number];
export type SupportCaseStatus = (typeof supportCaseStatus.enumValues)[number];
export type SupportAuthorType = (typeof supportAuthorType.enumValues)[number];
export type SupportAbuseCategory =
	(typeof supportAbuseCategory.enumValues)[number];
