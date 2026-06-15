// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      cli_logins: {
        Row: {
          created_at: string | null
          device_code: string
          expires_at: string | null
          profile_id: string | null
          refresh_token: string | null
          verification_code: string | null
        }
        Insert: {
          created_at?: string | null
          device_code: string
          expires_at?: string | null
          profile_id?: string | null
          refresh_token?: string | null
          verification_code?: string | null
        }
        Update: {
          created_at?: string | null
          device_code?: string
          expires_at?: string | null
          profile_id?: string | null
          refresh_token?: string | null
          verification_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cli_logins_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      cloud_identities: {
        Row: {
          cached_at: string | null
          cached_resources: {
  regions?: string[];
  vpcs?: Record<string, Array<{ ID: string; CIDR: string; Name: string; IsDefault: boolean }>>;
  subnets?: Record<string, Record<string, Array<{ ID: string; CIDR: string; VpcID: string; AvailabilityZone: string }>>> | Record<string, Array<{ name: string; region: string; ipCidrRange: string; network: string }>> | Record<string, Array<{ name: string; id: string; addressPrefix: string; vnetName: string }>>;
  hosted_zones?: Array<{ ID: string; Name: string; RecordCount: number; IsPrivate: boolean }>;
  networks?: Array<{ name: string; selfLink: string; autoCreateSubnetworks: boolean }>;
  managed_zones?: Array<{ name: string; dnsName: string; visibility: string }>;
  locations?: string[];
  vnets?: Array<{ name: string; id: string; location: string; addressPrefixes: string[] }>;
  dns_zones?: Array<{ name: string; id: string; zoneType: string }>;
} | null
          created_at: string | null
          credentials: { role_arn?: string | null; external_id?: string | null; account_id?: string | null; }
          id: string
          is_verified: boolean | null
          name: string
          provider: Database["public"]["Enums"]["cloud_provider"]
          updated_at: string | null
          user_id: string
        }
        Insert: {
          cached_at?: string | null
          cached_resources?: {
  regions?: string[];
  vpcs?: Record<string, Array<{ ID: string; CIDR: string; Name: string; IsDefault: boolean }>>;
  subnets?: Record<string, Record<string, Array<{ ID: string; CIDR: string; VpcID: string; AvailabilityZone: string }>>> | Record<string, Array<{ name: string; region: string; ipCidrRange: string; network: string }>> | Record<string, Array<{ name: string; id: string; addressPrefix: string; vnetName: string }>>;
  hosted_zones?: Array<{ ID: string; Name: string; RecordCount: number; IsPrivate: boolean }>;
  networks?: Array<{ name: string; selfLink: string; autoCreateSubnetworks: boolean }>;
  managed_zones?: Array<{ name: string; dnsName: string; visibility: string }>;
  locations?: string[];
  vnets?: Array<{ name: string; id: string; location: string; addressPrefixes: string[] }>;
  dns_zones?: Array<{ name: string; id: string; zoneType: string }>;
} | null
          created_at?: string | null
          credentials?: { role_arn?: string | null; external_id?: string | null; account_id?: string | null; }
          id?: string
          is_verified?: boolean | null
          name?: string
          provider: Database["public"]["Enums"]["cloud_provider"]
          updated_at?: string | null
          user_id?: string
        }
        Update: {
          cached_at?: string | null
          cached_resources?: {
  regions?: string[];
  vpcs?: Record<string, Array<{ ID: string; CIDR: string; Name: string; IsDefault: boolean }>>;
  subnets?: Record<string, Record<string, Array<{ ID: string; CIDR: string; VpcID: string; AvailabilityZone: string }>>> | Record<string, Array<{ name: string; region: string; ipCidrRange: string; network: string }>> | Record<string, Array<{ name: string; id: string; addressPrefix: string; vnetName: string }>>;
  hosted_zones?: Array<{ ID: string; Name: string; RecordCount: number; IsPrivate: boolean }>;
  networks?: Array<{ name: string; selfLink: string; autoCreateSubnetworks: boolean }>;
  managed_zones?: Array<{ name: string; dnsName: string; visibility: string }>;
  locations?: string[];
  vnets?: Array<{ name: string; id: string; location: string; addressPrefixes: string[] }>;
  dns_zones?: Array<{ name: string; id: string; zoneType: string }>;
} | null
          created_at?: string | null
          credentials?: { role_arn?: string | null; external_id?: string | null; account_id?: string | null; }
          id?: string
          is_verified?: boolean | null
          name?: string
          provider?: Database["public"]["Enums"]["cloud_provider"]
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      integrations: {
        Row: {
          auth_method: Database["public"]["Enums"]["integration_auth_method"]
          category: Database["public"]["Enums"]["integration_category"]
          created_at: string | null
          description: string
          docs_url: string | null
          icon_url: string
          id: string
          name: string
          organization: string
          privacy_url: string | null
          slug: string
          sort_order: number
          status: Database["public"]["Enums"]["integration_status"]
          support_url: string | null
          updated_at: string | null
        }
        Insert: {
          auth_method: Database["public"]["Enums"]["integration_auth_method"]
          category: Database["public"]["Enums"]["integration_category"]
          created_at?: string | null
          description: string
          docs_url?: string | null
          icon_url: string
          id?: string
          name: string
          organization: string
          privacy_url?: string | null
          slug: string
          sort_order?: number
          status?: Database["public"]["Enums"]["integration_status"]
          support_url?: string | null
          updated_at?: string | null
        }
        Update: {
          auth_method?: Database["public"]["Enums"]["integration_auth_method"]
          category?: Database["public"]["Enums"]["integration_category"]
          created_at?: string | null
          description?: string
          docs_url?: string | null
          icon_url?: string
          id?: string
          name?: string
          organization?: string
          privacy_url?: string | null
          slug?: string
          sort_order?: number
          status?: Database["public"]["Enums"]["integration_status"]
          support_url?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      job_logs: {
        Row: {
          created_at: string | null
          id: number
          job_id: string
          log_chunk: string
          stream_type: string | null
        }
        Insert: {
          created_at?: string | null
          id?: number
          job_id: string
          log_chunk: string
          stream_type?: string | null
        }
        Update: {
          created_at?: string | null
          id?: number
          job_id?: string
          log_chunk?: string
          stream_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_logs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "provision_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
        }
        Relationships: []
      }
      provider_tokens: {
        Row: {
          access_token: string
          created_at: string | null
          expires_at: string | null
          id: string
          provider: Database["public"]["Enums"]["git_provider"]
          refresh_token: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          access_token: string
          created_at?: string | null
          expires_at?: string | null
          id?: string
          provider: Database["public"]["Enums"]["git_provider"]
          refresh_token?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Update: {
          access_token?: string
          created_at?: string | null
          expires_at?: string | null
          id?: string
          provider?: Database["public"]["Enums"]["git_provider"]
          refresh_token?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      provision_jobs: {
        Row: {
          assigned_worker_id: string | null
          claimed_at: string | null
          cloud_identity_id: string | null
          completed_at: string | null
          config_snapshot: Record<string, unknown>
          configuration_hash: string | null
          created_at: string | null
          error_message: string | null
          execution_metadata: Record<string, unknown> | null
          id: string
          job_type: Database["public"]["Enums"]["provision_job_type"]
          plan_job_id: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["provision_job_status"]
          updated_at: string | null
          user_id: string
          vine_id: string | null
          vineyard_id: string | null
          worker_id: string | null
        }
        Insert: {
          assigned_worker_id?: string | null
          claimed_at?: string | null
          cloud_identity_id?: string | null
          completed_at?: string | null
          config_snapshot?: Record<string, unknown>
          configuration_hash?: string | null
          created_at?: string | null
          error_message?: string | null
          execution_metadata?: Record<string, unknown> | null
          id?: string
          job_type: Database["public"]["Enums"]["provision_job_type"]
          plan_job_id?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["provision_job_status"]
          updated_at?: string | null
          user_id?: string
          vine_id?: string | null
          vineyard_id?: string | null
          worker_id?: string | null
        }
        Update: {
          assigned_worker_id?: string | null
          claimed_at?: string | null
          cloud_identity_id?: string | null
          completed_at?: string | null
          config_snapshot?: Record<string, unknown>
          configuration_hash?: string | null
          created_at?: string | null
          error_message?: string | null
          execution_metadata?: Record<string, unknown> | null
          id?: string
          job_type?: Database["public"]["Enums"]["provision_job_type"]
          plan_job_id?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["provision_job_status"]
          updated_at?: string | null
          user_id?: string
          vine_id?: string | null
          vineyard_id?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "provision_jobs_assigned_worker_id_fkey"
            columns: ["assigned_worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provision_jobs_cloud_identity_id_fkey"
            columns: ["cloud_identity_id"]
            isOneToOne: false
            referencedRelation: "cloud_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provision_jobs_plan_job_id_fkey"
            columns: ["plan_job_id"]
            isOneToOne: false
            referencedRelation: "provision_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provision_jobs_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vine_full"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provision_jobs_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provision_jobs_vineyard_id_fkey"
            columns: ["vineyard_id"]
            isOneToOne: false
            referencedRelation: "vineyards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provision_jobs_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      vine_audit_log: {
        Row: {
          action: Database["public"]["Enums"]["audit_action"]
          changes: Record<string, unknown> | null
          component_id: string | null
          component_type: string | null
          created_at: string
          id: number
          user_id: string
          vine_id: string
        }
        Insert: {
          action: Database["public"]["Enums"]["audit_action"]
          changes?: Record<string, unknown> | null
          component_id?: string | null
          component_type?: string | null
          created_at?: string
          id?: number
          user_id?: string
          vine_id: string
        }
        Update: {
          action?: Database["public"]["Enums"]["audit_action"]
          changes?: Record<string, unknown> | null
          component_id?: string | null
          component_type?: string | null
          created_at?: string
          id?: number
          user_id?: string
          vine_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vine_audit_log_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vine_full"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vine_audit_log_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vines"
            referencedColumns: ["id"]
          },
        ]
      }
      vine_caches: {
        Row: {
          allowed_cidr_blocks: string[] | null
          created_at: string
          endpoint: string | null
          engine: Database["public"]["Enums"]["cache_engine"] | null
          estimated_monthly_cost: number | null
          id: string
          multi_az: boolean | null
          name: string
          node_type: string | null
          num_cache_nodes: number | null
          status: Database["public"]["Enums"]["component_status"]
          status_message: string | null
          updated_at: string
          vine_id: string
        }
        Insert: {
          allowed_cidr_blocks?: string[] | null
          created_at?: string
          endpoint?: string | null
          engine?: Database["public"]["Enums"]["cache_engine"] | null
          estimated_monthly_cost?: number | null
          id?: string
          multi_az?: boolean | null
          name: string
          node_type?: string | null
          num_cache_nodes?: number | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id: string
        }
        Update: {
          allowed_cidr_blocks?: string[] | null
          created_at?: string
          endpoint?: string | null
          engine?: Database["public"]["Enums"]["cache_engine"] | null
          estimated_monthly_cost?: number | null
          id?: string
          multi_az?: boolean | null
          name?: string
          node_type?: string | null
          num_cache_nodes?: number | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vine_caches_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vine_full"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vine_caches_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vines"
            referencedColumns: ["id"]
          },
        ]
      }
      vine_cluster: {
        Row: {
          argocd_admin_password: string | null
          argocd_url: string | null
          cluster_admins: Array<{ username: string; groups: string[] }> | null
          cluster_arn: string | null
          cluster_endpoint: string | null
          cluster_name: string | null
          cluster_version: string | null
          created_at: string
          estimated_monthly_cost: number | null
          id: string
          instance_types: string[] | null
          node_desired_size: number | null
          node_max_size: number | null
          node_min_size: number | null
          provider_config: { enable_karpenter?: boolean; enable_autopilot?: boolean; } | null
          status: Database["public"]["Enums"]["component_status"]
          status_message: string | null
          updated_at: string
          vine_id: string
        }
        Insert: {
          argocd_admin_password?: string | null
          argocd_url?: string | null
          cluster_admins?: Array<{ username: string; groups: string[] }> | null
          cluster_arn?: string | null
          cluster_endpoint?: string | null
          cluster_name?: string | null
          cluster_version?: string | null
          created_at?: string
          estimated_monthly_cost?: number | null
          id?: string
          instance_types?: string[] | null
          node_desired_size?: number | null
          node_max_size?: number | null
          node_min_size?: number | null
          provider_config?: { enable_karpenter?: boolean; enable_autopilot?: boolean; } | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id: string
        }
        Update: {
          argocd_admin_password?: string | null
          argocd_url?: string | null
          cluster_admins?: Array<{ username: string; groups: string[] }> | null
          cluster_arn?: string | null
          cluster_endpoint?: string | null
          cluster_name?: string | null
          cluster_version?: string | null
          created_at?: string
          estimated_monthly_cost?: number | null
          id?: string
          instance_types?: string[] | null
          node_desired_size?: number | null
          node_max_size?: number | null
          node_min_size?: number | null
          provider_config?: { enable_karpenter?: boolean; enable_autopilot?: boolean; } | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vine_eks_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: true
            referencedRelation: "vine_full"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vine_eks_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: true
            referencedRelation: "vines"
            referencedColumns: ["id"]
          },
        ]
      }
      vine_container_registries: {
        Row: {
          created_at: string
          id: string
          image_tag_mutability:
            | Database["public"]["Enums"]["registry_tag_mutability"]
            | null
          name: string
          provider_config: { vulnerability_scanning?: boolean; } | null
          repository_url: string | null
          scan_on_push: boolean | null
          status: Database["public"]["Enums"]["component_status"]
          status_message: string | null
          updated_at: string
          vine_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          image_tag_mutability?:
            | Database["public"]["Enums"]["registry_tag_mutability"]
            | null
          name: string
          provider_config?: { vulnerability_scanning?: boolean; } | null
          repository_url?: string | null
          scan_on_push?: boolean | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id: string
        }
        Update: {
          created_at?: string
          id?: string
          image_tag_mutability?:
            | Database["public"]["Enums"]["registry_tag_mutability"]
            | null
          name?: string
          provider_config?: { vulnerability_scanning?: boolean; } | null
          repository_url?: string | null
          scan_on_push?: boolean | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vine_ecr_repos_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vine_full"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vine_ecr_repos_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vines"
            referencedColumns: ["id"]
          },
        ]
      }
      vine_databases: {
        Row: {
          backup_retention_days: number | null
          cluster_arn: string | null
          cluster_identifier: string | null
          created_at: string
          credentials_kms_key_arn: string | null
          endpoint: string | null
          engine: string | null
          engine_version: string | null
          estimated_monthly_cost: number | null
          extra_credentials_secret_arn: string | null
          iam_auth: boolean | null
          id: string
          master_credentials_secret_arn: string | null
          max_capacity: number | null
          min_capacity: number | null
          name: string
          port: number | null
          reader_endpoint: string | null
          status: Database["public"]["Enums"]["component_status"]
          status_message: string | null
          updated_at: string
          vine_id: string
        }
        Insert: {
          backup_retention_days?: number | null
          cluster_arn?: string | null
          cluster_identifier?: string | null
          created_at?: string
          credentials_kms_key_arn?: string | null
          endpoint?: string | null
          engine?: string | null
          engine_version?: string | null
          estimated_monthly_cost?: number | null
          extra_credentials_secret_arn?: string | null
          iam_auth?: boolean | null
          id?: string
          master_credentials_secret_arn?: string | null
          max_capacity?: number | null
          min_capacity?: number | null
          name: string
          port?: number | null
          reader_endpoint?: string | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id: string
        }
        Update: {
          backup_retention_days?: number | null
          cluster_arn?: string | null
          cluster_identifier?: string | null
          created_at?: string
          credentials_kms_key_arn?: string | null
          endpoint?: string | null
          engine?: string | null
          engine_version?: string | null
          estimated_monthly_cost?: number | null
          extra_credentials_secret_arn?: string | null
          iam_auth?: boolean | null
          id?: string
          master_credentials_secret_arn?: string | null
          max_capacity?: number | null
          min_capacity?: number | null
          name?: string
          port?: number | null
          reader_endpoint?: string | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vine_databases_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vine_full"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vine_databases_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vines"
            referencedColumns: ["id"]
          },
        ]
      }
      vine_dns: {
        Row: {
          created_at: string
          domain_name: string | null
          enabled: boolean
          estimated_monthly_cost: number | null
          id: string
          managed_certificate: boolean | null
          provider_config: { acm_certificate?: boolean; cloudfront_waf?: boolean; application_waf?: boolean; cloud_armor?: boolean; azure_waf?: boolean; } | null
          status: Database["public"]["Enums"]["component_status"]
          status_message: string | null
          updated_at: string
          vine_id: string
          waf_enabled: boolean | null
          zone_id: string | null
        }
        Insert: {
          created_at?: string
          domain_name?: string | null
          enabled?: boolean
          estimated_monthly_cost?: number | null
          id?: string
          managed_certificate?: boolean | null
          provider_config?: { acm_certificate?: boolean; cloudfront_waf?: boolean; application_waf?: boolean; cloud_armor?: boolean; azure_waf?: boolean; } | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id: string
          waf_enabled?: boolean | null
          zone_id?: string | null
        }
        Update: {
          created_at?: string
          domain_name?: string | null
          enabled?: boolean
          estimated_monthly_cost?: number | null
          id?: string
          managed_certificate?: boolean | null
          provider_config?: { acm_certificate?: boolean; cloudfront_waf?: boolean; application_waf?: boolean; cloud_armor?: boolean; azure_waf?: boolean; } | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id?: string
          waf_enabled?: boolean | null
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vine_dns_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: true
            referencedRelation: "vine_full"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vine_dns_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: true
            referencedRelation: "vines"
            referencedColumns: ["id"]
          },
        ]
      }
      vine_git_credentials: {
        Row: {
          created_at: string
          id: string
          method: Database["public"]["Enums"]["git_credential_method"]
          provider_identity_id: string | null
          purpose: Database["public"]["Enums"]["git_credential_purpose"]
          secret_ref: string | null
          vine_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          method: Database["public"]["Enums"]["git_credential_method"]
          provider_identity_id?: string | null
          purpose: Database["public"]["Enums"]["git_credential_purpose"]
          secret_ref?: string | null
          vine_id: string
        }
        Update: {
          created_at?: string
          id?: string
          method?: Database["public"]["Enums"]["git_credential_method"]
          provider_identity_id?: string | null
          purpose?: Database["public"]["Enums"]["git_credential_purpose"]
          secret_ref?: string | null
          vine_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vine_git_credentials_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vine_full"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vine_git_credentials_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vines"
            referencedColumns: ["id"]
          },
        ]
      }
      vine_network: {
        Row: {
          allowed_cidr_blocks: string[] | null
          cidr_block: string | null
          created_at: string
          estimated_monthly_cost: number | null
          id: string
          network_id: string | null
          provision_network: boolean
          single_nat_gateway: boolean | null
          status: Database["public"]["Enums"]["component_status"]
          status_message: string | null
          updated_at: string
          vine_id: string
        }
        Insert: {
          allowed_cidr_blocks?: string[] | null
          cidr_block?: string | null
          created_at?: string
          estimated_monthly_cost?: number | null
          id?: string
          network_id?: string | null
          provision_network?: boolean
          single_nat_gateway?: boolean | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id: string
        }
        Update: {
          allowed_cidr_blocks?: string[] | null
          cidr_block?: string | null
          created_at?: string
          estimated_monthly_cost?: number | null
          id?: string
          network_id?: string | null
          provision_network?: boolean
          single_nat_gateway?: boolean | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vine_vpc_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: true
            referencedRelation: "vine_full"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vine_vpc_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: true
            referencedRelation: "vines"
            referencedColumns: ["id"]
          },
        ]
      }
      vine_nosql_tables: {
        Row: {
          billing_mode: Database["public"]["Enums"]["nosql_billing_mode"] | null
          created_at: string
          estimated_monthly_cost: number | null
          global_replicas: string[] | null
          hash_key: string
          hash_key_type: Database["public"]["Enums"]["nosql_key_type"] | null
          id: string
          name: string
          point_in_time_recovery: boolean | null
          provider_config: { partition_key_path?: string; } | null
          range_key: string | null
          range_key_type: Database["public"]["Enums"]["nosql_key_type"] | null
          status: Database["public"]["Enums"]["component_status"]
          status_message: string | null
          table_type: Database["public"]["Enums"]["nosql_table_type"] | null
          updated_at: string
          vine_id: string
        }
        Insert: {
          billing_mode?:
            | Database["public"]["Enums"]["nosql_billing_mode"]
            | null
          created_at?: string
          estimated_monthly_cost?: number | null
          global_replicas?: string[] | null
          hash_key: string
          hash_key_type?: Database["public"]["Enums"]["nosql_key_type"] | null
          id?: string
          name: string
          point_in_time_recovery?: boolean | null
          provider_config?: { partition_key_path?: string; } | null
          range_key?: string | null
          range_key_type?: Database["public"]["Enums"]["nosql_key_type"] | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          table_type?: Database["public"]["Enums"]["nosql_table_type"] | null
          updated_at?: string
          vine_id: string
        }
        Update: {
          billing_mode?:
            | Database["public"]["Enums"]["nosql_billing_mode"]
            | null
          created_at?: string
          estimated_monthly_cost?: number | null
          global_replicas?: string[] | null
          hash_key?: string
          hash_key_type?: Database["public"]["Enums"]["nosql_key_type"] | null
          id?: string
          name?: string
          point_in_time_recovery?: boolean | null
          provider_config?: { partition_key_path?: string; } | null
          range_key?: string | null
          range_key_type?: Database["public"]["Enums"]["nosql_key_type"] | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          table_type?: Database["public"]["Enums"]["nosql_table_type"] | null
          updated_at?: string
          vine_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vine_dynamodb_tables_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vine_full"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vine_dynamodb_tables_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vines"
            referencedColumns: ["id"]
          },
        ]
      }
      vine_queues: {
        Row: {
          created_at: string
          delay_seconds: number | null
          estimated_monthly_cost: number | null
          fifo: boolean | null
          id: string
          message_retention: number | null
          name: string
          status: Database["public"]["Enums"]["component_status"]
          status_message: string | null
          updated_at: string
          vine_id: string
          visibility_timeout: number | null
        }
        Insert: {
          created_at?: string
          delay_seconds?: number | null
          estimated_monthly_cost?: number | null
          fifo?: boolean | null
          id?: string
          message_retention?: number | null
          name: string
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id: string
          visibility_timeout?: number | null
        }
        Update: {
          created_at?: string
          delay_seconds?: number | null
          estimated_monthly_cost?: number | null
          fifo?: boolean | null
          id?: string
          message_retention?: number | null
          name?: string
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id?: string
          visibility_timeout?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "vine_queues_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vine_full"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vine_queues_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vines"
            referencedColumns: ["id"]
          },
        ]
      }
      vine_repositories: {
        Row: {
          apps_destination_repo: string | null
          created_at: string
          id: string
          updated_at: string
          vine_id: string
        }
        Insert: {
          apps_destination_repo?: string | null
          created_at?: string
          id?: string
          updated_at?: string
          vine_id: string
        }
        Update: {
          apps_destination_repo?: string | null
          created_at?: string
          id?: string
          updated_at?: string
          vine_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vine_repositories_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: true
            referencedRelation: "vine_full"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vine_repositories_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: true
            referencedRelation: "vines"
            referencedColumns: ["id"]
          },
        ]
      }
      vine_secrets: {
        Row: {
          created_at: string
          generate: boolean | null
          id: string
          length: number | null
          name: string
          special_chars: boolean | null
          status: Database["public"]["Enums"]["component_status"]
          status_message: string | null
          updated_at: string
          vine_id: string
        }
        Insert: {
          created_at?: string
          generate?: boolean | null
          id?: string
          length?: number | null
          name: string
          special_chars?: boolean | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id: string
        }
        Update: {
          created_at?: string
          generate?: boolean | null
          id?: string
          length?: number | null
          name?: string
          special_chars?: boolean | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vine_secrets_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vine_full"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vine_secrets_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vines"
            referencedColumns: ["id"]
          },
        ]
      }
      vine_storage_buckets: {
        Row: {
          cors_origins: string[] | null
          created_at: string
          encryption: string | null
          estimated_monthly_cost: number | null
          id: string
          name: string
          public_access: boolean | null
          status: Database["public"]["Enums"]["component_status"] | null
          status_message: string | null
          updated_at: string
          versioning: boolean | null
          vine_id: string
        }
        Insert: {
          cors_origins?: string[] | null
          created_at?: string
          encryption?: string | null
          estimated_monthly_cost?: number | null
          id?: string
          name: string
          public_access?: boolean | null
          status?: Database["public"]["Enums"]["component_status"] | null
          status_message?: string | null
          updated_at?: string
          versioning?: boolean | null
          vine_id: string
        }
        Update: {
          cors_origins?: string[] | null
          created_at?: string
          encryption?: string | null
          estimated_monthly_cost?: number | null
          id?: string
          name?: string
          public_access?: boolean | null
          status?: Database["public"]["Enums"]["component_status"] | null
          status_message?: string | null
          updated_at?: string
          versioning?: boolean | null
          vine_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vine_storage_buckets_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vine_full"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vine_storage_buckets_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vines"
            referencedColumns: ["id"]
          },
        ]
      }
      vine_topics: {
        Row: {
          created_at: string
          estimated_monthly_cost: number | null
          id: string
          name: string
          status: Database["public"]["Enums"]["component_status"]
          status_message: string | null
          subscriptions: Array<{ protocol: string; endpoint: string }> | null
          updated_at: string
          vine_id: string
        }
        Insert: {
          created_at?: string
          estimated_monthly_cost?: number | null
          id?: string
          name: string
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          subscriptions?: Array<{ protocol: string; endpoint: string }> | null
          updated_at?: string
          vine_id: string
        }
        Update: {
          created_at?: string
          estimated_monthly_cost?: number | null
          id?: string
          name?: string
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          subscriptions?: Array<{ protocol: string; endpoint: string }> | null
          updated_at?: string
          vine_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vine_topics_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vine_full"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vine_topics_vine_id_fkey"
            columns: ["vine_id"]
            isOneToOne: false
            referencedRelation: "vines"
            referencedColumns: ["id"]
          },
        ]
      }
      vines: {
        Row: {
          cloud_identity_id: string | null
          created_at: string
          environment_stage: Database["public"]["Enums"]["environment_stage"]
          estimated_monthly_cost: number | null
          id: string
          project_name: string
          region: string
          status: Database["public"]["Enums"]["vine_status"]
          terraform_version: string
          updated_at: string
          user_id: string
          vineyard_id: string | null
        }
        Insert: {
          cloud_identity_id?: string | null
          created_at?: string
          environment_stage?: Database["public"]["Enums"]["environment_stage"]
          estimated_monthly_cost?: number | null
          id?: string
          project_name: string
          region?: string
          status?: Database["public"]["Enums"]["vine_status"]
          terraform_version?: string
          updated_at?: string
          user_id?: string
          vineyard_id?: string | null
        }
        Update: {
          cloud_identity_id?: string | null
          created_at?: string
          environment_stage?: Database["public"]["Enums"]["environment_stage"]
          estimated_monthly_cost?: number | null
          id?: string
          project_name?: string
          region?: string
          status?: Database["public"]["Enums"]["vine_status"]
          terraform_version?: string
          updated_at?: string
          user_id?: string
          vineyard_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vines_cloud_identity_id_fkey"
            columns: ["cloud_identity_id"]
            isOneToOne: false
            referencedRelation: "cloud_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vines_vineyard_id_fkey"
            columns: ["vineyard_id"]
            isOneToOne: false
            referencedRelation: "vineyards"
            referencedColumns: ["id"]
          },
        ]
      }
      vineyards: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          name: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          name: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          name?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      worker_releases: {
        Row: {
          commit_sha: string | null
          github_release_url: string | null
          id: string
          is_breaking: boolean
          release_notes: string
          released_at: string
          version: string
        }
        Insert: {
          commit_sha?: string | null
          github_release_url?: string | null
          id?: string
          is_breaking?: boolean
          release_notes?: string
          released_at?: string
          version: string
        }
        Update: {
          commit_sha?: string | null
          github_release_url?: string | null
          id?: string
          is_breaking?: boolean
          release_notes?: string
          released_at?: string
          version?: string
        }
        Relationships: []
      }
      workers: {
        Row: {
          cloud_identity_id: string | null
          created_at: string | null
          id: string
          is_default: boolean
          last_heartbeat: string | null
          metadata: Record<string, unknown> | null
          mode: Database["public"]["Enums"]["worker_mode"]
          name: string
          release_id: string | null
          status: Database["public"]["Enums"]["worker_status"] | null
          token_hash: string
          user_id: string | null
          version: string | null
        }
        Insert: {
          cloud_identity_id?: string | null
          created_at?: string | null
          id?: string
          is_default?: boolean
          last_heartbeat?: string | null
          metadata?: Record<string, unknown> | null
          mode: Database["public"]["Enums"]["worker_mode"]
          name: string
          release_id?: string | null
          status?: Database["public"]["Enums"]["worker_status"] | null
          token_hash: string
          user_id?: string | null
          version?: string | null
        }
        Update: {
          cloud_identity_id?: string | null
          created_at?: string | null
          id?: string
          is_default?: boolean
          last_heartbeat?: string | null
          metadata?: Record<string, unknown> | null
          mode?: Database["public"]["Enums"]["worker_mode"]
          name?: string
          release_id?: string | null
          status?: Database["public"]["Enums"]["worker_status"] | null
          token_hash?: string
          user_id?: string | null
          version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "workers_cloud_identity_id_fkey"
            columns: ["cloud_identity_id"]
            isOneToOne: false
            referencedRelation: "cloud_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workers_release_id_fkey"
            columns: ["release_id"]
            isOneToOne: false
            referencedRelation: "worker_releases"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      vine_full: {
        Row: {
          acm_certificate_enable: boolean | null
          application_waf_enabled: boolean | null
          applications_destination_repo: string | null
          aws_account_id: string | null
          aws_region: string | null
          cloud_identity_id: string | null
          cloud_provider: Database["public"]["Enums"]["cloud_provider"] | null
          cloudfront_waf_enabled: boolean | null
          cluster_admins: Json | null
          cluster_endpoint: string | null
          cluster_name: string | null
          cluster_status: string | null
          cluster_version: string | null
          create_rds: boolean | null
          create_vpc: boolean | null
          created_at: string | null
          db_max_capacity: number | null
          db_min_capacity: number | null
          dns_hosted_zone: string | null
          dns_main_domain: string | null
          dns_status: string | null
          eks_status: string | null
          enable_dns: boolean | null
          enable_karpenter: boolean | null
          enable_redis: boolean | null
          environment_stage: string | null
          estimated_monthly_cost: number | null
          id: string | null
          instance_types: string[] | null
          network_status: string | null
          node_desired_size: number | null
          node_max_size: number | null
          node_min_size: number | null
          project_name: string | null
          region: string | null
          selected_vpc_id: string | null
          single_nat_gateway: boolean | null
          status: string | null
          terraform_version: string | null
          updated_at: string | null
          user_id: string | null
          vineyard_id: string | null
          vpc_cidr: string | null
          vpc_status: string | null
          waf_enabled: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "vines_cloud_identity_id_fkey"
            columns: ["cloud_identity_id"]
            isOneToOne: false
            referencedRelation: "cloud_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vines_vineyard_id_fkey"
            columns: ["vineyard_id"]
            isOneToOne: false
            referencedRelation: "vineyards"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      claim_next_job: {
        Args: {
          p_cloud_identity_id?: string
          p_worker_id: string
          p_worker_token_hash: string
        }
        Returns: {
          assigned_worker_id: string | null
          claimed_at: string | null
          cloud_identity_id: string | null
          completed_at: string | null
          config_snapshot: Json
          configuration_hash: string | null
          created_at: string | null
          error_message: string | null
          execution_metadata: Json | null
          id: string
          job_type: Database["public"]["Enums"]["provision_job_type"]
          plan_job_id: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["provision_job_status"]
          updated_at: string | null
          user_id: string
          vine_id: string | null
          vineyard_id: string | null
          worker_id: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "provision_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      insert_job_log: {
        Args: {
          p_job_id: string
          p_log_chunk: string
          p_stream_type?: string
          p_worker_id: string
          p_worker_token_hash: string
        }
        Returns: undefined
      }
      recover_stale_jobs: { Args: never; Returns: number }
      set_default_worker: { Args: { p_worker_id?: string }; Returns: undefined }
      update_job_status: {
        Args: {
          p_error_message?: string
          p_execution_metadata?: Json
          p_job_id: string
          p_status: string
          p_worker_id: string
          p_worker_token_hash: string
        }
        Returns: undefined
      }
      worker_heartbeat:
        | {
            Args: { p_worker_id: string; p_worker_token_hash: string }
            Returns: undefined
          }
        | {
            Args: {
              p_version?: string
              p_worker_id: string
              p_worker_token_hash: string
            }
            Returns: undefined
          }
    }
    Enums: {
      audit_action:
        | "CREATED"
        | "UPDATED"
        | "DELETED"
        | "PROVISIONED"
        | "DESTROYED"
        | "COMPONENT_ADDED"
        | "COMPONENT_UPDATED"
        | "COMPONENT_REMOVED"
        | "STATUS_CHANGED"
      cache_engine: "redis" | "valkey"
      cloud_provider: "aws" | "azure" | "gcp"
      cluster_status: "PENDING" | "ONLINE" | "OFFLINE"
      component_status:
        | "PENDING"
        | "CREATING"
        | "ACTIVE"
        | "UPDATING"
        | "FAILED"
        | "DESTROYING"
        | "DESTROYED"
      deployment_resource_status:
        | "creating"
        | "created"
        | "updating"
        | "deleting"
        | "deleted"
        | "failed"
      deployment_status:
        | "pending"
        | "initializing"
        | "planning"
        | "applying"
        | "completed"
        | "failed"
        | "cancelled"
        | "destroying"
      environment_stage: "development" | "staging" | "production"
      git_credential_method: "oauth" | "pat" | "deploy_key"
      git_credential_purpose: "argocd" | "applications" | "infrastructure"
      git_provider: "github" | "bitbucket" | "gitlab"
      iac_tool: "pulumi" | "terraform"
      integration_auth_method:
        | "oauth"
        | "iam_role"
        | "service_account"
        | "service_principal"
        | "ram_role"
        | "api_key"
      integration_category:
        | "git"
        | "cloud"
        | "observability"
        | "registry"
        | "dns"
        | "secrets"
      integration_status: "active" | "coming_soon"
      logs_level: "debug" | "info" | "warn" | "error" | "critical"
      nosql_billing_mode: "PAY_PER_REQUEST" | "PROVISIONED"
      nosql_key_type: "S" | "N" | "B"
      nosql_table_type: "standard" | "global"
      provision_job_status:
        | "QUEUED"
        | "CLAIMED"
        | "PROCESSING"
        | "SUCCESS"
        | "FAILED"
        | "CANCELLED"
      provision_job_type:
        | "DESTROY_WORKER"
        | "DEPLOY"
        | "DESTROY"
        | "CONNECTION_TEST"
        | "FETCH_RESOURCES"
        | "PLAN"
        | "DEPLOY_WORKER"
        | "UPDATE_WORKER"
      registry_tag_mutability: "MUTABLE" | "IMMUTABLE"
      vine_status:
        | "DRAFT"
        | "QUEUED"
        | "PROVISIONING"
        | "ACTIVE"
        | "FAILED"
        | "DESTROYING"
        | "DESTROYED"
      worker_mode: "self-hosted" | "cloud-hosted"
      worker_status: "ONLINE" | "OFFLINE" | "DRAINING"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      audit_action: [
        "CREATED",
        "UPDATED",
        "DELETED",
        "PROVISIONED",
        "DESTROYED",
        "COMPONENT_ADDED",
        "COMPONENT_UPDATED",
        "COMPONENT_REMOVED",
        "STATUS_CHANGED",
      ],
      cache_engine: ["redis", "valkey"],
      cloud_provider: ["aws", "azure", "gcp"],
      cluster_status: ["PENDING", "ONLINE", "OFFLINE"],
      component_status: [
        "PENDING",
        "CREATING",
        "ACTIVE",
        "UPDATING",
        "FAILED",
        "DESTROYING",
        "DESTROYED",
      ],
      deployment_resource_status: [
        "creating",
        "created",
        "updating",
        "deleting",
        "deleted",
        "failed",
      ],
      deployment_status: [
        "pending",
        "initializing",
        "planning",
        "applying",
        "completed",
        "failed",
        "cancelled",
        "destroying",
      ],
      environment_stage: ["development", "staging", "production"],
      git_credential_method: ["oauth", "pat", "deploy_key"],
      git_credential_purpose: ["argocd", "applications", "infrastructure"],
      git_provider: ["github", "bitbucket", "gitlab"],
      iac_tool: ["pulumi", "terraform"],
      integration_auth_method: [
        "oauth",
        "iam_role",
        "service_account",
        "service_principal",
        "ram_role",
        "api_key",
      ],
      integration_category: [
        "git",
        "cloud",
        "observability",
        "registry",
        "dns",
        "secrets",
      ],
      integration_status: ["active", "coming_soon"],
      logs_level: ["debug", "info", "warn", "error", "critical"],
      nosql_billing_mode: ["PAY_PER_REQUEST", "PROVISIONED"],
      nosql_key_type: ["S", "N", "B"],
      nosql_table_type: ["standard", "global"],
      provision_job_status: [
        "QUEUED",
        "CLAIMED",
        "PROCESSING",
        "SUCCESS",
        "FAILED",
        "CANCELLED",
      ],
      provision_job_type: [
        "DESTROY_WORKER",
        "DEPLOY",
        "DESTROY",
        "CONNECTION_TEST",
        "FETCH_RESOURCES",
        "PLAN",
        "DEPLOY_WORKER",
        "UPDATE_WORKER",
      ],
      registry_tag_mutability: ["MUTABLE", "IMMUTABLE"],
      vine_status: [
        "DRAFT",
        "QUEUED",
        "PROVISIONING",
        "ACTIVE",
        "FAILED",
        "DESTROYING",
        "DESTROYED",
      ],
      worker_mode: ["self-hosted", "cloud-hosted"],
      worker_status: ["ONLINE", "OFFLINE", "DRAINING"],
    },
  },
} as const
