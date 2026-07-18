// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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

// An environment is either long-lived (`persistent` — dev/staging/prod) or time-bounded
// (`ephemeral` — a disposable, TTL'd environment; the product "Sandbox" surface). Inert for
// now: the column exists so the reaper + UI can build on it, but nothing reads it yet.
export const environmentLifecycle = pgEnum("environment_lifecycle", [
	"persistent",
	"ephemeral",
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

// How a marketplace add-on is delivered into the cluster: `managed` = Alethia renders +
// applies the ArgoCD Application directly; `gitops` = the manifest is written into the
// customer's apps repo for them to own + edit, and ArgoCD syncs it from there.
export const addonMode = pgEnum("addon_mode", ["managed", "gitops"]);

export const cacheEngine = pgEnum("cache_engine", ["redis", "valkey"]);

// The kind of Kubernetes workload a service compiles to. Matches the service form fragment's
// `type` union (lib/validations/project-form.schema.ts) so the column can't hold a value the
// form rejects — replaces the loose `text` the getProjectAsFormData narrowing helper guarded.
export const serviceWorkloadType = pgEnum("service_workload_type", [
	"deployment",
	"job",
	"cronjob",
	"statefulset",
]);

// W3 service→backing-resource bindings (service.bindings / chart_workload.bindings JSONB, and the
// normalized service_bindings table). `kind` is the bound resource's kind; `facet` is which
// connection facet an env var receives (endpoint/port are non-secret templated values; the rest
// inject keylessly via ESO). SSOT for both the TS interfaces (types/jsonb.types.ts) and the Go
// runner's ServiceBindingTarget.Kind / ServiceBindingInjection.From (enums_gen.go).
export const serviceBindingKind = pgEnum("service_binding_kind", [
	"database",
	"cache",
	"queue",
	"secret",
]);
export const serviceBindingFacet = pgEnum("service_binding_facet", [
	"endpoint",
	"port",
	"username",
	"password",
	"connection_string",
]);

// Delivery protocol of a topic subscription (topic.subscriptions JSONB / topic_subscriptions table).
// The finite set the inspector offers + the templates provision (SNS-style fan-out).
export const topicSubscriptionProtocol = pgEnum("topic_subscription_protocol", [
	"https",
	"sqs",
	"email",
	"lambda",
]);

// The kind of Kubernetes workload DESCRIBED from a BYO Helm chart's rendered manifests (W5 Path A —
// project_chart_workloads). Superset of serviceWorkloadType (adds `daemonset`, which a chart can
// render but Alethia never authors as a first-class service). Normalized to lowercase from the
// rendered manifest's PascalCase `kind`.
export const chartWorkloadKind = pgEnum("chart_workload_kind", [
	"deployment",
	"statefulset",
	"daemonset",
	"cronjob",
	"job",
]);

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
	// Bring-your-own Helm chart safety scan: clone → helm template → verify.EvaluateManifests.
	"CHART_SCAN",
	// Bring-your-own IaC (E3) module scan: clone → pin commit → inventory providers/modules →
	// tofu validate. Its result gates the env's PLAN/DEPLOY/DESTROY (finalizeIacScan pins commit_sha).
	"IAC_SCAN",
	// Break-glass privileged state surgery: an operator-initiated, two-person-approved,
	// fully-audited repair of a corrupt/stranded tofu state, queued as a NORMAL job so it flows
	// through claim_next_job → the tofu-state lock/backend (fencing intact) instead of a raw UPDATE.
	// The runner-side executor ships INERT (fail-closed): it refuses unless the runner opts in via
	// ALETHIA_BREAKGLASS_STATE_SURGERY_ENABLED, so no state is ever mutated through an unproven path.
	"STATE_SURGERY",
	// Live cluster-alive signal (BYOC B2): reads the env's tofu state outputs in-process (kubeconfig
	// via the state-proxy path; outputs are NEVER persisted), dials the cluster API server, and writes
	// one honest environment_probes row. Unreachable is a SUCCESSFUL probe with reachable=false — the
	// job only FAILS when the probe itself couldn't run, not when the cluster is down.
	"PROBE_CLUSTER",
	// W2 image build & push: for each service where source.kind=="repo", schedule an in-cluster
	// kaniko Job (git context + Dockerfile → push to the provisioned registry via build-SA IRSA),
	// watch it, and report a per-service digest map { service_name → image_digest_uri } in
	// execution_metadata.build_result. Digests are non-secret; registry credentials must never
	// enter execution_metadata. Runs AFTER infra-up (the cluster hosts the build), BEFORE the
	// app-workload manifest commit (which substitutes resolved_image).
	"BUILD",
]);

// Break-glass (privileged incident recovery) action catalog + per-action blast-radius label.
// The catalog metadata (which actions require two-person approval, which are inert) lives in
// lib/breakglass/catalog.ts; these enums are the durable, immutable audit lexicon so a
// breakglass_audit row's `action`/`blast_radius` are constrained at the DB, not free text.
export const breakglassAction = pgEnum("breakglass_action", [
	"open_session",
	"inspect_job",
	"retry_job",
	"cancel_job",
	"unstick_env",
	"drain_runner",
	"restart_runner",
	"replay_webhook",
	"force_release_state_lock",
	"state_surgery",
	"orphan_detect",
	"orphan_clean",
]);
export const breakglassBlastRadius = pgEnum("breakglass_blast_radius", [
	"none",
	"low",
	"medium",
	"high",
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

// One managed-fleet controller action, recorded to the fleet_actions ledger so there's a
// durable record of WHY the scaler created/drained/destroyed a VM. `noop` is reserved for a
// "considered, held" tick and is not emitted on every idle reconcile (that would be noise).
export const fleetActionType = pgEnum("fleet_action_type", [
	"create",
	"drain",
	"destroy",
	"noop",
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

// Structured resource classification (Workstream B). The kind of resource an assignment
// pins a classification value to. Each value maps to a table whose PK is a uuid, so a
// single `resource_id uuid` addresses every kind. Adding a new classifiable surface is a
// one-line edit here (+ a migration) — the assignment row is otherwise kind-agnostic.
export const resourceKind = pgEnum("resource_kind", [
	"cloud_identity",
	"connector_credential",
	"alert_rule",
	"alert_channel",
	"alert_delivery",
	"member",
	"project",
	"project_environment",
	"project_cluster",
	"cloud_kubernetes_cluster",
	"role",
	"runner",
	"runner_usage_session",
	"support_case",
]);

// Support-case enums moved to @repo/support (shared with the admin app); re-export
// so `@/lib/db/schema/enums` keeps surfacing them (supportCaseType/Status/Severity/… + their
// TS unions).
export * from "@repo/support/enums";

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
export type FleetActionType = (typeof fleetActionType.enumValues)[number];
export type ProjectStatus = (typeof projectStatus.enumValues)[number];
export type ComponentStatus = (typeof componentStatus.enumValues)[number];
export type AddonMode = (typeof addonMode.enumValues)[number];
export type EnvironmentStage = (typeof environmentStage.enumValues)[number];
export type PromotionStatus = (typeof promotionStatus.enumValues)[number];
export type ApprovalStatus = (typeof approvalStatus.enumValues)[number];
export type CacheEngine = (typeof cacheEngine.enumValues)[number];
export type ServiceBindingKind =
	(typeof serviceBindingKind.enumValues)[number];
export type ServiceBindingFacet =
	(typeof serviceBindingFacet.enumValues)[number];
export type TopicSubscriptionProtocol =
	(typeof topicSubscriptionProtocol.enumValues)[number];
export type ChartWorkloadKind = (typeof chartWorkloadKind.enumValues)[number];
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
export type ResourceKind = (typeof resourceKind.enumValues)[number];
export type BreakglassAction = (typeof breakglassAction.enumValues)[number];
export type BreakglassBlastRadius =
	(typeof breakglassBlastRadius.enumValues)[number];
// SupportCase* / SupportAuthorType / SupportAbuseCategory unions come via the
// `export * from "@repo/support/enums"` re-export above.
