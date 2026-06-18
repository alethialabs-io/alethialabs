// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Typed JSONB shapes for the Drizzle schema's `.$type<>()` columns (lib/db/schema).
// Formerly also overlaid onto the Supabase-generated `Database` type via MergeDeep;
// that generated type + the supabase clients are gone, so only the interfaces remain.

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
}

export interface NosqlProviderConfig {
	partition_key_path?: string;
}

export interface RegistryProviderConfig {
	vulnerability_scanning?: boolean;
}

export interface TopicSubscription {
	protocol: string;
	endpoint: string;
}

export interface AuditChanges {
	[key: string]: unknown;
}

export interface WorkerDeployConfig {
	region: string;
	cloud_provider: string;
	image_tag: string;
	trellis_url: string;
	cpu: number;
	memory: number;
	image_repository: string;
	worker_token?: string;
}

export interface WorkerMetadata {
	deploy_config?: WorkerDeployConfig | null;
}
