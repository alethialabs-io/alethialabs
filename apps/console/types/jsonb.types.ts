// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Typed JSONB shapes for the Drizzle schema's `.$type<>()` columns (lib/db/schema).

import type { AlertSeverity } from "@/lib/db/schema/enums";

// ── Typed JSONB interfaces ─────────────────────────────────────────

export interface CloudCredentials {
	// AWS
	role_arn?: string | null;
	external_id?: string | null;
	account_id?: string | null;
	// GCP (WIF)
	project_id?: string | null;
	project_number?: string | null;
	service_account_email?: string | null;
	wif_config?: Record<string, unknown> | null;
	// Azure (Federated Identity)
	tenant_id?: string | null;
	client_id?: string | null;
	subscription_id?: string | null;
	// DigitalOcean / Hetzner / Civo — no role-federation exists for these clouds, so a
	// scoped API token is stored ENCRYPTED at rest (decrypted only on the runner at claim).
	// Alibaba uses role_arn/external_id above (RAM role = zero stored credentials).
	token?: EncryptedSecret | null;
	// Self-managed mode (token clouds only): no token is stored in Alethia at all — the
	// customer's self-hosted runner supplies it from its own environment (HCLOUD_TOKEN,
	// CIVO_TOKEN, DIGITALOCEAN_ACCESS_TOKEN). The honest zero-trust path for clouds with
	// no federation: the secret never enters Alethia's database.
	self_managed?: boolean | null;
}

export interface VpcInfo {
	ID: string;
	CIDR: string;
	Name: string;
	IsDefault: boolean;
}

/**
 * A service detected inside a source repo by the scanner (monorepo-aware). One repo
 * may yield several — e.g. `apps/api` + `apps/web` in a workspace. Stored on
 * `project_source_repos.services` and consumed by per-service inference.
 */
export interface DetectedService {
	/** Path within the repo, relative; "" = repo root. */
	path: string;
	/** Service name, derived from the directory or manifest. */
	name: string;
	/** Whether a Dockerfile exists at this service's path. */
	hasDockerfile: boolean;
	/** Inferred runtime (node/python/go/…), when detected. */
	runtime?: string;
	/** Container port, when detected from the Dockerfile/manifest. */
	port?: number;
}

// ── Support cases ───────────────────────────────────────────────────
// SupportContactPrefs / SupportCaseContext / SupportAbuseDetails moved to @repo/support
// (shared with the admin app); re-exported so `@/types/jsonb.types` still surfaces them.
export * from "@repo/support/types";

/**
 * One resource that has drifted from its provisioned state — mirrors the Go
 * `drift.ResourceDrift` (packages/core/drift). Stored on `environment_drift.details`;
 * produced by a DETECT_DRIFT job's `tofu plan -refresh-only` → `drift.Analyze`.
 */
export interface DriftDetail {
	/** Terraform address of the drifted resource. */
	address: string;
	/** Resource type (e.g. aws_db_instance). */
	type: string;
	/** "modified" | "deleted" | "other" — how it diverged. */
	kind: string;
}

export interface SubnetInfo {
	ID: string;
	CIDR: string;
	VpcID: string;
	AvailabilityZone: string;
}

export interface HostedZoneInfo {
	ID: string;
	Name: string;
	RecordCount: number;
	IsPrivate: boolean;
}

export interface IAMUserInfo {
	username: string;
	arn: string;
	path: string;
}

export interface CachedResources {
	regions: string[];
	vpcs: Record<string, VpcInfo[]>;
	subnets: Record<string, Record<string, SubnetInfo[]>>;
	hosted_zones: HostedZoneInfo[];
	iam_users?: IAMUserInfo[];
}

export interface GcpNetworkInfo {
	name: string;
	selfLink: string;
	autoCreateSubnetworks: boolean;
}

export interface GcpSubnetInfo {
	name: string;
	region: string;
	ipCidrRange: string;
	network: string;
}

export interface GcpManagedZoneInfo {
	name: string;
	dnsName: string;
	visibility: string;
}

export interface GcpCachedResources {
	regions: string[];
	networks: GcpNetworkInfo[];
	subnets: Record<string, GcpSubnetInfo[]>;
	managed_zones: GcpManagedZoneInfo[];
}

export interface AzureVnetInfo {
	name: string;
	id: string;
	location: string;
	addressPrefixes: string[];
}

export interface AzureSubnetInfo {
	name: string;
	id: string;
	addressPrefix: string;
	vnetName: string;
}

export interface AzureDnsZoneInfo {
	name: string;
	id: string;
	zoneType: string;
}

export interface AzureCachedResources {
	locations: string[];
	vnets: AzureVnetInfo[];
	subnets: Record<string, AzureSubnetInfo[]>;
	dns_zones: AzureDnsZoneInfo[];
}

export interface ClusterAdmin {
	username: string;
	groups: string[];
}

export interface ClusterProviderConfig {
	enable_karpenter?: boolean;
	enable_autopilot?: boolean;
	enable_cluster_autoscaler?: boolean;
}

export interface DnsProviderConfig {
	acm_certificate?: boolean;
	managed_certificate?: boolean;
	cloudfront_waf?: boolean;
	application_waf?: boolean;
	cloud_armor?: boolean;
	azure_waf?: boolean;
	// Cloudflare (pluggable DNS provider)
	zone_id?: string;
	proxied?: boolean;
}

export interface NosqlProviderConfig {
	partition_key_path?: string;
}

export interface RegistryProviderConfig {
	vulnerability_scanning?: boolean;
	immutable_tags?: boolean;
	// Docker Hub (pluggable registry provider)
	namespace?: string;
}

// Vault (pluggable secrets provider) — non-secret knobs only; the address/token
// credential lives in connector_credentials, never here.
export interface SecretsProviderConfig {
	mount_path?: string;
	kv_version?: string;
}

// Datadog / Grafana Cloud / Prometheus — non-secret knobs only.
export interface ObservabilityProviderConfig {
	// Datadog
	site?: string;
	// Grafana Cloud / Prometheus remote-write
	remote_write_url?: string;
	// Prometheus (in-cluster)
	retention_days?: string;
}

// AES-256-GCM envelope for the secret fields of a connector credential
// (lib/crypto/secrets.ts). The plaintext is a JSON map of {fieldKey: value}.
export interface EncryptedSecret {
	v: number;
	iv: string;
	tag: string;
	data: string;
}

// connector_credentials.credentials — non-secret fields (e.g. Vault address,
// Docker Hub username) stored plaintext; secret fields encrypted into `secret`.
export interface ConnectorCredentials {
	fields?: Record<string, string>;
	secret?: EncryptedSecret | null;
}

export interface StorageProviderConfig {
	// AES256 / aws:kms (S3), google-managed / CMEK (GCS), etc.
	encryption_algorithm?: string;
	kms_key?: string;
}

export interface QueueProviderConfig {
	// SQS-only delivery delay (Azure Service Bus / Pub/Sub have no direct equivalent).
	delay_seconds?: number;
}

// Provider-specific resource identifiers captured after a deploy (cloud-agnostic
// keys). Replaces the AWS-shaped typed columns (cluster_arn, *_secret_arn, kms…)
// — AWS fills arn/secret_ref/kms_key; GCP/Azure fill the keys their model uses.
export interface ProviderOutputs {
	arn?: string;
	identifier?: string;
	secret_ref?: string;
	extra_secret_ref?: string;
	kms_key?: string;
}

export interface TopicSubscription {
	protocol: string;
	endpoint: string;
}

export interface AuditChanges {
	[key: string]: unknown;
}

export interface RunnerDeployConfig {
	region: string;
	cloud_provider: string;
	image_tag: string;
	alethia_url: string;
	cpu: number;
	memory: number;
	image_repository: string;
	runner_token?: string;
}

export interface RunnerMetadata {
	deploy_config?: RunnerDeployConfig | null;
	/**
	 * Cloud instance id of the VM hosting this managed runner (e.g. a Hetzner server
	 * id). Set at bootstrap; lets the fleet scaler correlate a DB runner ↔ its server
	 * for graceful scale-down. Null for non-fleet (bundled/self) runners.
	 */
	cloud_instance_id?: string | null;
}

// jobs.execution_metadata — written by the runner via update_job_status. Known
// shape (deploy outputs + cached cloud resources from CONNECTION_TEST/FETCH jobs).
export interface ExecutionMetadata {
	cluster_name?: string;
	cluster_endpoint?: string;
	argocd_url?: string;
	argocd_admin_password?: string;
	outputs?: Record<string, unknown>;
	cached_resources?:
		| CachedResources
		| GcpCachedResources
		| AzureCachedResources;
	// PLAN jobs: the runner stores the raw OpenTofu plan JSON + Infracost breakdown
	// here (opaque payloads parsed by lib/plan/parse-plan.ts / parse-cost.ts).
	plan_result?: Record<string, unknown>;
	cost_breakdown?: Record<string, unknown>;
	// ANALYZE_REPO jobs: the runner's static repo analysis (packages/core/scanner).
	repo_digest?: RepoDigest;
	// PLAN/DEPLOY jobs: the elench verification gate's result for the plan
	// (packages/core/verify). On DEPLOY a blocking verdict stops apply.
	verify_result?: VerifyReport;
	// PLAN/DEPLOY jobs: the signed evidence receipt sealing the report to the plan
	// hash + tool versions (packages/core/verify Receipt/SignedReceipt).
	verify_receipt?: SignedReceipt;
	// DETECT_DRIFT jobs: the per-environment drift posture (packages/core/drift).
	drift_posture?: DriftPosture;
}

// Mirrors the Go `drift.Posture` (packages/core/drift). `unmanaged_known` is false
// for a refresh-only plan — it cannot see resources that exist in the cloud but
// not in state.
export interface DriftResource {
	address: string;
	type: string;
	kind: "modified" | "deleted" | "other";
}

export interface DriftPosture {
	in_sync: boolean;
	drifted: number;
	details?: DriftResource[];
	unmanaged: number;
	unmanaged_known: boolean;
	scanned_at?: string;
}

// ── Verification gate (elench) ───────────────────────────────────────────────
// Mirrors the Go `verify.Report` (packages/core/verify/types.go). The deterministic
// policy gate runs between `tofu plan` and `tofu apply`; `not_evaluable` means the
// plan JSON lacked the information to judge a control — NEVER a silent pass.

export type VerifyStatus = "pass" | "fail" | "warn" | "not_evaluable";

export interface VerifyFinding {
	address: string;
	message: string;
}

export interface VerifyControlResult {
	id: string;
	title: string;
	severity: "high" | "medium" | "low";
	status: VerifyStatus;
	frameworks?: string[];
	provider: string;
	findings?: VerifyFinding[];
	/** Plain-language note on what this control could NOT inspect on this plan. */
	coverage?: string;
}

export interface VerifySummary {
	pass: number;
	fail: number;
	warn: number;
	not_evaluable: number;
}

export interface VerifyReport {
	verdict: VerifyStatus;
	catalog_version: string;
	provider: string;
	controls: VerifyControlResult[];
	summary: VerifySummary;
}

// A waiver recorded in the receipt when an apply proceeded despite a failing
// control (the verdict itself is NOT rewritten — the exception explains why).
export interface RecordedException {
	controls: string[];
	reason: string;
	by: string;
	expiry?: string;
}

// jobs.verify_override — an authorized, time-boxed waiver attached to a DEPLOY job.
// The runner passes it to the fail-closed gate (packages/core/verify Override). `by`
// is set server-side to the authorizing actor; `expiry` is RFC3339.
export interface VerifyOverrideInput {
	controls: string[];
	reason: string;
	by: string;
	expiry?: string;
}

// Mirrors the Go `verify.Receipt` — the per-apply evidence record.
export interface VerifyReceiptBody {
	version: string;
	plan_sha256: string;
	tofu_version?: string;
	provider_versions?: Record<string, string>;
	catalog_version: string;
	provider: string;
	verdict: VerifyStatus;
	report: VerifyReport;
	exception?: RecordedException;
	runner?: string;
	evaluated_at?: string;
}

// Mirrors the Go `verify.SignedReceipt`. `algorithm` is "ed25519" when signed or
// "none" when a signing key was not configured.
export interface SignedReceipt {
	receipt: VerifyReceiptBody;
	algorithm: string;
	key_id?: string;
	signature?: string;
}

// One captured (truncated) file from a scanned repo. Mirrors packages/core/types RepoFile.
export interface RepoFile {
	path: string;
	content: string;
	truncated?: boolean;
}

// Deterministic static analysis of a repository (ANALYZE_REPO job). Mirrors the Go
// `RepoDigest` (packages/core/types/repo_digest.go); fed to the model to infer a Project.
export interface RepoDigest {
	repo_url: string;
	ref?: string;
	scanned_at: string;
	file_count: number;
	truncated?: boolean;
	languages?: Record<string, number>;
	manifests?: RepoFile[];
	dockerfiles?: RepoFile[];
	compose?: RepoFile[];
	k8s_manifests?: RepoFile[];
	ci_configs?: RepoFile[];
	env_examples?: RepoFile[];
	signals?: string[];
	/** Monorepo-aware deployable services detected in the repo (path + runtime/port). */
	services?: DetectedService[];
}

// ── Alerting (dataroom/spec/mvp/25-alerting-notifications.md) ────────────────────────────

// alert_channels.config — non-secret channel settings. The sensitive material
// (webhook/Slack/RocketChat URL, optional webhook signing secret) lives in the
// encrypted `secret` column, never here.
export interface AlertChannelConfig {
	// email channel: who receives the alert.
	recipients?: string[];
}

// alert_rules.match — field-equality narrowing of an event type. Empty = "all
// events of this type". Compound/boolean expressions are an ee/ capability.
export interface AlertRuleMatch {
	job_types?: string[];
	project_ids?: string[];
	resource_types?: string[];
	actions?: string[];
	min_severity?: AlertSeverity;
}

// alert_deliveries.context — the rendered event payload captured at emit time, so
// a delivery is replayable and the Activity view is self-describing. Fields are
// optional because they vary by source (authz vs jobs vs connector health).
export interface AlertEventContext {
	title: string;
	summary?: string;
	severity?: AlertSeverity;
	// authz / governance sources
	actor_id?: string;
	action?: string;
	resource_type?: string;
	resource_id?: string;
	reason?: string;
	// job / project sources
	job_id?: string;
	job_type?: string;
	project_id?: string;
	// connector source
	connector_slug?: string;
	// deep link into the console
	link?: string;
}

// email_suppression.detail — the salient bits of the SES bounce/complaint
// notification that produced the suppression, kept for audit/debugging.
export interface EmailSuppressionDetail {
	// SES feedback id (bounce/complaint) — also the natural idempotency key.
	feedback_id?: string;
	// Original outbound message id, when the event carries it.
	ses_message_id?: string;
	// Bounce classification (e.g. "Permanent" / "General").
	bounce_type?: string;
	bounce_sub_type?: string;
	// Complaint feedback type (e.g. "abuse").
	complaint_feedback_type?: string;
	// Remote MTA diagnostic text, if any.
	diagnostic?: string;
}

/**
 * Payload of a staged project change (project_changes.payload). It's a cloud-indifferent
 * component-config delta whose shape depends on component_type (database, cache, …), so it
 * is intentionally an open record rather than one fixed interface — the canvas diff and
 * applyStagedChanges validate it against the matching drizzle-zod schema before it lands.
 */
export type StagedChangePayload = Record<string, unknown>;

/**
 * Cloud-indifferent cluster node capability (project_cluster.node_size). The Go catalog
 * resolver maps it to the nearest per-provider instance type at provision time.
 */
export interface NodeSize {
	vcpu: number;
	memory_gb: number;
}

/**
 * Provider-nuance bag on a cloud inventory row (cloud_* tables' `attributes`). The typed columns
 * carry the cross-cloud common shape; this holds the genuinely provider-specific extras
 * (e.g. AWS `arn`, Azure `resource_group`, GCP `self_link`, tags) — heterogeneous by design, so a
 * constrained primitive map rather than one fixed interface.
 */
export type CloudInventoryAttributes = Record<
	string,
	string | number | boolean | null | string[]
>;

/**
 * The reconnaissance-sensitive attributes of an inventory row (CIDRs, IPs, endpoints, DNS domains).
 * Sealed with AES-GCM into the `sensitive` text column (via inventory/upsert `sealSensitive`) and
 * decrypted only on read (`openSensitive`). All values are strings (the AES envelope stores a
 * `Record<string,string>`). We never store raw resource tags.
 */
export interface CloudSensitiveAttrs {
	cidr_block?: string;
	private_ip?: string;
	public_ip?: string;
	endpoint?: string;
	domain?: string;
	repository_url?: string;
}

// ============================================================
// Environment promotion (Phase 2). Stored on environment_promotions / _protection_rules.
// ============================================================

/** Who may approve a promotion into a protected environment. Stored on `environment_protection_rules.approvers`. */
export interface ApproverSpec {
	/** Explicit user ids allowed to approve. */
	user_ids: string[];
	/** A built-in role (owner/admin/operator/…) whose members may approve; null = only listed users. */
	role: string | null;
	/** How many distinct approvals are required. */
	min_count: number;
}

/** A single field's before/after in a promotion UPDATE. */
export interface ComponentFieldChange {
	from: unknown;
	to: unknown;
}

/** One component's change in a promotion changeset. `key` is the component_type for singletons,
 * else the resource `name` (source_repos: `repo_url|scan_path`). */
export interface ComponentChange {
	component_type: string;
	key: string;
	op: "CREATE" | "UPDATE" | "DELETE";
	/** Structural field diffs (UPDATE only). */
	fields?: Record<string, ComponentFieldChange>;
}

/** The promotable delta from a source env's design to a target env's, plus a human summary.
 * Stored on `environment_promotions.diff_summary`. */
export interface PromotionDiff {
	changes: ComponentChange[];
	summary: string[];
	/** Whether the actor opted into applying DELETEs (target-only components). */
	include_removals: boolean;
}

/** Per-rule outcome of a protection-gate evaluation. */
export interface GateResult {
	type:
		| "predecessor_healthy"
		| "manual_approval"
		| "verify_pass"
		| "soak_timer"
		| "cost_delta";
	status: "pass" | "fail" | "pending" | "skipped";
	detail: string;
}

/** The overall gate evaluation for a promotion. Stored on `environment_promotions.gate_evaluations`. */
export interface GateEvaluation {
	overall: "pass" | "blocked" | "pending_approval";
	results: GateResult[];
	/** RFC3339 timestamp of the evaluation. */
	evaluated_at: string;
}
