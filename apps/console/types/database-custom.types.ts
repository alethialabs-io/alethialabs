// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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
}

// ── Alerting (spec/mvp/25-alerting-notifications.md) ────────────────────────────

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
	zone_ids?: string[];
	spec_ids?: string[];
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
	// job / spec sources
	job_id?: string;
	job_type?: string;
	spec_id?: string;
	zone_id?: string;
	// connector source
	connector_slug?: string;
	// deep link into the console
	link?: string;
}
