import type { MergeDeep } from "type-fest";
import type { Database as DatabaseGenerated } from "./database.types";

// ── Typed JSONB interfaces ─────────────────────────────────────────

export interface CloudCredentials {
	role_arn?: string | null;
	external_id?: string | null;
	account_id?: string | null;
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

export interface CachedResources {
	regions: string[];
	vpcs: Record<string, VpcInfo[]>;
	subnets: Record<string, Record<string, SubnetInfo[]>>;
	hosted_zones: HostedZoneInfo[];
}

export interface ClusterMetadata {
	region?: string | null;
	vpc_cidr?: string | null;
	[key: string]: unknown;
}

export interface EksClusterAdmin {
	username: string;
	groups: string[];
}

export interface TopicSubscription {
	protocol: string;
	endpoint: string;
}

export interface AuditChanges {
	[key: string]: unknown;
}

export interface WorkerMetadata {
	[key: string]: unknown;
}

// ── MergeDeep override ─────────────────────────────────────────────

export type Database = MergeDeep<
	DatabaseGenerated,
	{
		public: {
			Tables: {
				cloud_identities: {
					Row: {
						credentials: CloudCredentials;
						cached_resources: CachedResources | null;
					};
					Insert: {
						credentials?: CloudCredentials;
						cached_resources?: CachedResources | null;
					};
					Update: {
						credentials?: CloudCredentials;
						cached_resources?: CachedResources | null;
					};
				};
				clusters: {
					Row: { metadata: ClusterMetadata | null };
					Insert: { metadata?: ClusterMetadata | null };
					Update: { metadata?: ClusterMetadata | null };
				};
				provision_jobs: {
					Row: {
						config_snapshot: Record<string, unknown>;
						execution_metadata: Record<string, unknown> | null;
					};
					Insert: {
						config_snapshot?: Record<string, unknown>;
						execution_metadata?: Record<string, unknown> | null;
					};
					Update: {
						config_snapshot?: Record<string, unknown>;
						execution_metadata?: Record<string, unknown> | null;
					};
				};
				vine_audit_log: {
					Row: { changes: AuditChanges | null };
					Insert: { changes?: AuditChanges | null };
					Update: { changes?: AuditChanges | null };
				};
				vine_eks: {
					Row: { cluster_admins: EksClusterAdmin[] | null };
					Insert: { cluster_admins?: EksClusterAdmin[] | null };
					Update: { cluster_admins?: EksClusterAdmin[] | null };
				};
				vine_topics: {
					Row: { subscriptions: TopicSubscription[] | null };
					Insert: { subscriptions?: TopicSubscription[] | null };
					Update: { subscriptions?: TopicSubscription[] | null };
				};
				workers: {
					Row: { metadata: WorkerMetadata | null };
					Insert: { metadata?: WorkerMetadata | null };
					Update: { metadata?: WorkerMetadata | null };
				};
			};
		};
	}
>;
