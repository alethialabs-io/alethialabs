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
      bootstrap_jobs: {
        Row: {
          completed_at: string | null
          created_at: string | null
          error_message: string | null
          id: string
          status: string
          updated_at: string | null
          user_id: string
          vineyard_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          status?: string
          updated_at?: string | null
          user_id: string
          vineyard_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          status?: string
          updated_at?: string | null
          user_id?: string
          vineyard_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bootstrap_jobs_vineyard_id_fkey"
            columns: ["vineyard_id"]
            isOneToOne: false
            referencedRelation: "vineyards"
            referencedColumns: ["id"]
          },
        ]
      }
      bootstrap_logs: {
        Row: {
          created_at: string | null
          id: number
          job_id: string
          log_chunk: string
          stream_type: string
        }
        Insert: {
          created_at?: string | null
          id?: number
          job_id: string
          log_chunk: string
          stream_type?: string
        }
        Update: {
          created_at?: string | null
          id?: number
          job_id?: string
          log_chunk?: string
          stream_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "bootstrap_logs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "bootstrap_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
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
          cached_resources: Json | null
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
          cached_resources?: Json | null
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
          cached_resources?: Json | null
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
      clusters: {
        Row: {
          agent_token_hash: string | null
          created_at: string | null
          id: string
          last_heartbeat: string | null
          metadata: { region?: string | null; vpc_cidr?: string | null; [key: string]: any; } | null
          name: string
          status: Database["public"]["Enums"]["cluster_status"] | null
          user_id: string
        }
        Insert: {
          agent_token_hash?: string | null
          created_at?: string | null
          id?: string
          last_heartbeat?: string | null
          metadata?: { region?: string | null; vpc_cidr?: string | null; [key: string]: any; } | null
          name: string
          status?: Database["public"]["Enums"]["cluster_status"] | null
          user_id: string
        }
        Update: {
          agent_token_hash?: string | null
          created_at?: string | null
          id?: string
          last_heartbeat?: string | null
          metadata?: { region?: string | null; vpc_cidr?: string | null; [key: string]: any; } | null
          name?: string
          status?: Database["public"]["Enums"]["cluster_status"] | null
          user_id?: string
        }
        Relationships: []
      }
      configurations: {
        Row: {
          applications_destination_repo: string | null
          applications_template_repo: string | null
          aws_account_id: string | null
          aws_region: string | null
          cloud_identity_id: string | null
          cluster_id: string | null
          container_platform: string
          create_rds: boolean | null
          create_vpc: boolean | null
          created_at: string | null
          db_max_capacity: number | null
          db_min_capacity: number | null
          description: string | null
          dns_domain_name: string | null
          dns_hosted_zone: string | null
          download_count: number | null
          eks_cluster_admins: string | null
          enable_cloudfront_waf: boolean | null
          enable_dns: boolean | null
          enable_gitops_destination: boolean | null
          enable_karpenter: boolean | null
          enable_redis: boolean | null
          env_git_repo: string | null
          environment_repository: string | null
          environment_stage: string
          full_config: Json | null
          gitops_app_template: string | null
          gitops_app_token: string | null
          gitops_argocd_token: string | null
          gitops_destination_repo: string | null
          gitops_destinations_repo: string | null
          gitops_infra_destination_repo: string | null
          gitops_repository: string | null
          id: string
          last_downloaded_at: string | null
          project_name: string
          redis_allowed_cidr_blocks: string | null
          ses_queues_topics: string | null
          status: string | null
          terraform_version: string
          ui_position_x: number | null
          ui_position_y: number | null
          updated_at: string | null
          user_id: string
          vineyard_id: string | null
          vpc_cidr: string | null
        }
        Insert: {
          applications_destination_repo?: string | null
          applications_template_repo?: string | null
          aws_account_id?: string | null
          aws_region?: string | null
          cloud_identity_id?: string | null
          cluster_id?: string | null
          container_platform: string
          create_rds?: boolean | null
          create_vpc?: boolean | null
          created_at?: string | null
          db_max_capacity?: number | null
          db_min_capacity?: number | null
          description?: string | null
          dns_domain_name?: string | null
          dns_hosted_zone?: string | null
          download_count?: number | null
          eks_cluster_admins?: string | null
          enable_cloudfront_waf?: boolean | null
          enable_dns?: boolean | null
          enable_gitops_destination?: boolean | null
          enable_karpenter?: boolean | null
          enable_redis?: boolean | null
          env_git_repo?: string | null
          environment_repository?: string | null
          environment_stage: string
          full_config?: Json | null
          gitops_app_template?: string | null
          gitops_app_token?: string | null
          gitops_argocd_token?: string | null
          gitops_destination_repo?: string | null
          gitops_destinations_repo?: string | null
          gitops_infra_destination_repo?: string | null
          gitops_repository?: string | null
          id?: string
          last_downloaded_at?: string | null
          project_name: string
          redis_allowed_cidr_blocks?: string | null
          ses_queues_topics?: string | null
          status?: string | null
          terraform_version: string
          ui_position_x?: number | null
          ui_position_y?: number | null
          updated_at?: string | null
          user_id?: string
          vineyard_id?: string | null
          vpc_cidr?: string | null
        }
        Update: {
          applications_destination_repo?: string | null
          applications_template_repo?: string | null
          aws_account_id?: string | null
          aws_region?: string | null
          cloud_identity_id?: string | null
          cluster_id?: string | null
          container_platform?: string
          create_rds?: boolean | null
          create_vpc?: boolean | null
          created_at?: string | null
          db_max_capacity?: number | null
          db_min_capacity?: number | null
          description?: string | null
          dns_domain_name?: string | null
          dns_hosted_zone?: string | null
          download_count?: number | null
          eks_cluster_admins?: string | null
          enable_cloudfront_waf?: boolean | null
          enable_dns?: boolean | null
          enable_gitops_destination?: boolean | null
          enable_karpenter?: boolean | null
          enable_redis?: boolean | null
          env_git_repo?: string | null
          environment_repository?: string | null
          environment_stage?: string
          full_config?: Json | null
          gitops_app_template?: string | null
          gitops_app_token?: string | null
          gitops_argocd_token?: string | null
          gitops_destination_repo?: string | null
          gitops_destinations_repo?: string | null
          gitops_infra_destination_repo?: string | null
          gitops_repository?: string | null
          id?: string
          last_downloaded_at?: string | null
          project_name?: string
          redis_allowed_cidr_blocks?: string | null
          ses_queues_topics?: string | null
          status?: string | null
          terraform_version?: string
          ui_position_x?: number | null
          ui_position_y?: number | null
          updated_at?: string | null
          user_id?: string
          vineyard_id?: string | null
          vpc_cidr?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "configurations_cloud_identity_id_fkey"
            columns: ["cloud_identity_id"]
            isOneToOne: false
            referencedRelation: "cloud_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "configurations_cluster_id_fkey"
            columns: ["cluster_id"]
            isOneToOne: false
            referencedRelation: "clusters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "configurations_vineyard_id_fkey"
            columns: ["vineyard_id"]
            isOneToOne: false
            referencedRelation: "vineyards"
            referencedColumns: ["id"]
          },
        ]
      }
      deployment_logs: {
        Row: {
          created_at: string | null
          deployment_id: string
          id: string
          level: Database["public"]["Enums"]["logs_level"]
          message: string
          step: string | null
        }
        Insert: {
          created_at?: string | null
          deployment_id: string
          id?: string
          level: Database["public"]["Enums"]["logs_level"]
          message: string
          step?: string | null
        }
        Update: {
          created_at?: string | null
          deployment_id?: string
          id?: string
          level?: Database["public"]["Enums"]["logs_level"]
          message?: string
          step?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deployment_logs_deployment_id_fkey"
            columns: ["deployment_id"]
            isOneToOne: false
            referencedRelation: "deployments"
            referencedColumns: ["id"]
          },
        ]
      }
      deployment_resources: {
        Row: {
          aws_arn: string | null
          created_at: string | null
          deployment_id: string
          id: string
          properties: Json | null
          resource_id: string | null
          resource_name: string
          resource_type: string
          status: Database["public"]["Enums"]["deployment_resource_status"]
          updated_at: string | null
        }
        Insert: {
          aws_arn?: string | null
          created_at?: string | null
          deployment_id: string
          id?: string
          properties?: Json | null
          resource_id?: string | null
          resource_name: string
          resource_type: string
          status?: Database["public"]["Enums"]["deployment_resource_status"]
          updated_at?: string | null
        }
        Update: {
          aws_arn?: string | null
          created_at?: string | null
          deployment_id?: string
          id?: string
          properties?: Json | null
          resource_id?: string | null
          resource_name?: string
          resource_type?: string
          status?: Database["public"]["Enums"]["deployment_resource_status"]
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deployment_resources_deployment_id_fkey"
            columns: ["deployment_id"]
            isOneToOne: false
            referencedRelation: "deployments"
            referencedColumns: ["id"]
          },
        ]
      }
      deployments: {
        Row: {
          aws_region: string | null
          completed_at: string | null
          completed_steps: number | null
          configuration_id: string | null
          created_at: string | null
          current_step: string | null
          description: string | null
          duration_seconds: number | null
          error_message: string | null
          iac_tool: Database["public"]["Enums"]["iac_tool"]
          id: string
          lock_id: string | null
          logs: string | null
          name: string
          outputs: Json | null
          profile_id: string
          progress_percentage: number | null
          pulumi_version: string | null
          started_at: string | null
          state_bucket: string | null
          state_key: string | null
          status: Database["public"]["Enums"]["deployment_status"]
          terraform_version: string | null
          total_steps: number | null
          updated_at: string | null
        }
        Insert: {
          aws_region?: string | null
          completed_at?: string | null
          completed_steps?: number | null
          configuration_id?: string | null
          created_at?: string | null
          current_step?: string | null
          description?: string | null
          duration_seconds?: number | null
          error_message?: string | null
          iac_tool: Database["public"]["Enums"]["iac_tool"]
          id?: string
          lock_id?: string | null
          logs?: string | null
          name: string
          outputs?: Json | null
          profile_id: string
          progress_percentage?: number | null
          pulumi_version?: string | null
          started_at?: string | null
          state_bucket?: string | null
          state_key?: string | null
          status?: Database["public"]["Enums"]["deployment_status"]
          terraform_version?: string | null
          total_steps?: number | null
          updated_at?: string | null
        }
        Update: {
          aws_region?: string | null
          completed_at?: string | null
          completed_steps?: number | null
          configuration_id?: string | null
          created_at?: string | null
          current_step?: string | null
          description?: string | null
          duration_seconds?: number | null
          error_message?: string | null
          iac_tool?: Database["public"]["Enums"]["iac_tool"]
          id?: string
          lock_id?: string | null
          logs?: string | null
          name?: string
          outputs?: Json | null
          profile_id?: string
          progress_percentage?: number | null
          pulumi_version?: string | null
          started_at?: string | null
          state_bucket?: string | null
          state_key?: string | null
          status?: Database["public"]["Enums"]["deployment_status"]
          terraform_version?: string | null
          total_steps?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deployments_configuration_id_fkey"
            columns: ["configuration_id"]
            isOneToOne: false
            referencedRelation: "configurations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deployments_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      eks_admins: {
        Row: {
          created_at: string | null
          email: string
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          email: string
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          email?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      harvests: {
        Row: {
          completed_at: string | null
          configuration_id: string
          created_at: string | null
          error_message: string | null
          id: string
          logs: string | null
          status: string
          ui_position_x: number | null
          ui_position_y: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          configuration_id: string
          created_at?: string | null
          error_message?: string | null
          id?: string
          logs?: string | null
          status?: string
          ui_position_x?: number | null
          ui_position_y?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          completed_at?: string | null
          configuration_id?: string
          created_at?: string | null
          error_message?: string | null
          id?: string
          logs?: string | null
          status?: string
          ui_position_x?: number | null
          ui_position_y?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "harvests_configuration_id_fkey"
            columns: ["configuration_id"]
            isOneToOne: false
            referencedRelation: "configurations"
            referencedColumns: ["id"]
          },
        ]
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
          claimed_at: string | null
          cloud_identity_id: string | null
          cluster_id: string | null
          completed_at: string | null
          config_snapshot: Json
          configuration_hash: string | null
          configuration_id: string | null
          created_at: string | null
          error_message: string | null
          execution_metadata: Json | null
          id: string
          job_type: string
          started_at: string | null
          status: string
          updated_at: string | null
          user_id: string
          vine_id: string | null
          vineyard_id: string | null
          worker_id: string | null
        }
        Insert: {
          claimed_at?: string | null
          cloud_identity_id?: string | null
          cluster_id?: string | null
          completed_at?: string | null
          config_snapshot?: Json
          configuration_hash?: string | null
          configuration_id?: string | null
          created_at?: string | null
          error_message?: string | null
          execution_metadata?: Json | null
          id?: string
          job_type: string
          started_at?: string | null
          status?: string
          updated_at?: string | null
          user_id?: string
          vine_id?: string | null
          vineyard_id?: string | null
          worker_id?: string | null
        }
        Update: {
          claimed_at?: string | null
          cloud_identity_id?: string | null
          cluster_id?: string | null
          completed_at?: string | null
          config_snapshot?: Json
          configuration_hash?: string | null
          configuration_id?: string | null
          created_at?: string | null
          error_message?: string | null
          execution_metadata?: Json | null
          id?: string
          job_type?: string
          started_at?: string | null
          status?: string
          updated_at?: string | null
          user_id?: string
          vine_id?: string | null
          vineyard_id?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "provision_jobs_cloud_identity_id_fkey"
            columns: ["cloud_identity_id"]
            isOneToOne: false
            referencedRelation: "cloud_identities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provision_jobs_cluster_id_fkey"
            columns: ["cluster_id"]
            isOneToOne: false
            referencedRelation: "clusters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provision_jobs_configuration_id_fkey"
            columns: ["configuration_id"]
            isOneToOne: false
            referencedRelation: "configurations"
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
        ]
      }
      provision_logs: {
        Row: {
          created_at: string | null
          id: number
          log_chunk: string
          provision_id: string
          stream_type: string | null
        }
        Insert: {
          created_at?: string | null
          id?: number
          log_chunk: string
          provision_id: string
          stream_type?: string | null
        }
        Update: {
          created_at?: string | null
          id?: number
          log_chunk?: string
          provision_id?: string
          stream_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "provision_logs_provision_id_fkey"
            columns: ["provision_id"]
            isOneToOne: false
            referencedRelation: "provisions"
            referencedColumns: ["id"]
          },
        ]
      }
      provisions: {
        Row: {
          cluster_id: string
          completed_at: string | null
          config_snapshot: Json
          configuration_hash: string | null
          created_at: string | null
          error_message: string | null
          execution_metadata: Json | null
          id: string
          started_at: string | null
          status: string | null
        }
        Insert: {
          cluster_id: string
          completed_at?: string | null
          config_snapshot: Json
          configuration_hash?: string | null
          created_at?: string | null
          error_message?: string | null
          execution_metadata?: Json | null
          id?: string
          started_at?: string | null
          status?: string | null
        }
        Update: {
          cluster_id?: string
          completed_at?: string | null
          config_snapshot?: Json
          configuration_hash?: string | null
          created_at?: string | null
          error_message?: string | null
          execution_metadata?: Json | null
          id?: string
          started_at?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "provisions_cluster_id_fkey"
            columns: ["cluster_id"]
            isOneToOne: false
            referencedRelation: "clusters"
            referencedColumns: ["id"]
          },
        ]
      }
      vine_audit_log: {
        Row: {
          action: Database["public"]["Enums"]["audit_action"]
          changes: Json | null
          component_id: string | null
          component_type: string | null
          created_at: string
          id: number
          user_id: string
          vine_id: string
        }
        Insert: {
          action: Database["public"]["Enums"]["audit_action"]
          changes?: Json | null
          component_id?: string | null
          component_type?: string | null
          created_at?: string
          id?: number
          user_id?: string
          vine_id: string
        }
        Update: {
          action?: Database["public"]["Enums"]["audit_action"]
          changes?: Json | null
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
      vine_databases: {
        Row: {
          backup_retention_days: number | null
          created_at: string
          endpoint: string | null
          engine: string | null
          engine_version: string | null
          estimated_monthly_cost: number | null
          iam_auth: boolean | null
          id: string
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
          created_at?: string
          endpoint?: string | null
          engine?: string | null
          engine_version?: string | null
          estimated_monthly_cost?: number | null
          iam_auth?: boolean | null
          id?: string
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
          created_at?: string
          endpoint?: string | null
          engine?: string | null
          engine_version?: string | null
          estimated_monthly_cost?: number | null
          iam_auth?: boolean | null
          id?: string
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
          acm_certificate: boolean | null
          application_waf: boolean | null
          cloudfront_waf: boolean | null
          created_at: string
          domain_name: string | null
          enabled: boolean
          estimated_monthly_cost: number | null
          hosted_zone_id: string | null
          id: string
          status: Database["public"]["Enums"]["component_status"]
          status_message: string | null
          updated_at: string
          vine_id: string
        }
        Insert: {
          acm_certificate?: boolean | null
          application_waf?: boolean | null
          cloudfront_waf?: boolean | null
          created_at?: string
          domain_name?: string | null
          enabled?: boolean
          estimated_monthly_cost?: number | null
          hosted_zone_id?: string | null
          id?: string
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id: string
        }
        Update: {
          acm_certificate?: boolean | null
          application_waf?: boolean | null
          cloudfront_waf?: boolean | null
          created_at?: string
          domain_name?: string | null
          enabled?: boolean
          estimated_monthly_cost?: number | null
          hosted_zone_id?: string | null
          id?: string
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id?: string
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
      vine_dynamodb_tables: {
        Row: {
          billing_mode:
            | Database["public"]["Enums"]["dynamodb_billing_mode"]
            | null
          created_at: string
          estimated_monthly_cost: number | null
          global_replicas: string[] | null
          hash_key: string
          hash_key_type: Database["public"]["Enums"]["dynamodb_key_type"] | null
          id: string
          name: string
          point_in_time_recovery: boolean | null
          range_key: string | null
          range_key_type:
            | Database["public"]["Enums"]["dynamodb_key_type"]
            | null
          status: Database["public"]["Enums"]["component_status"]
          status_message: string | null
          table_type: Database["public"]["Enums"]["dynamodb_table_type"] | null
          updated_at: string
          vine_id: string
        }
        Insert: {
          billing_mode?:
            | Database["public"]["Enums"]["dynamodb_billing_mode"]
            | null
          created_at?: string
          estimated_monthly_cost?: number | null
          global_replicas?: string[] | null
          hash_key: string
          hash_key_type?:
            | Database["public"]["Enums"]["dynamodb_key_type"]
            | null
          id?: string
          name: string
          point_in_time_recovery?: boolean | null
          range_key?: string | null
          range_key_type?:
            | Database["public"]["Enums"]["dynamodb_key_type"]
            | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          table_type?: Database["public"]["Enums"]["dynamodb_table_type"] | null
          updated_at?: string
          vine_id: string
        }
        Update: {
          billing_mode?:
            | Database["public"]["Enums"]["dynamodb_billing_mode"]
            | null
          created_at?: string
          estimated_monthly_cost?: number | null
          global_replicas?: string[] | null
          hash_key?: string
          hash_key_type?:
            | Database["public"]["Enums"]["dynamodb_key_type"]
            | null
          id?: string
          name?: string
          point_in_time_recovery?: boolean | null
          range_key?: string | null
          range_key_type?:
            | Database["public"]["Enums"]["dynamodb_key_type"]
            | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          table_type?: Database["public"]["Enums"]["dynamodb_table_type"] | null
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
      vine_ecr_repos: {
        Row: {
          created_at: string
          id: string
          image_tag_mutability:
            | Database["public"]["Enums"]["ecr_tag_mutability"]
            | null
          name: string
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
            | Database["public"]["Enums"]["ecr_tag_mutability"]
            | null
          name: string
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
            | Database["public"]["Enums"]["ecr_tag_mutability"]
            | null
          name?: string
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
      vine_eks: {
        Row: {
          cluster_admins: Json | null
          cluster_endpoint: string | null
          cluster_name: string | null
          cluster_version: string | null
          created_at: string
          enable_karpenter: boolean | null
          estimated_monthly_cost: number | null
          id: string
          instance_types: string[] | null
          node_desired_size: number | null
          node_max_size: number | null
          node_min_size: number | null
          status: Database["public"]["Enums"]["component_status"]
          status_message: string | null
          updated_at: string
          vine_id: string
        }
        Insert: {
          cluster_admins?: Json | null
          cluster_endpoint?: string | null
          cluster_name?: string | null
          cluster_version?: string | null
          created_at?: string
          enable_karpenter?: boolean | null
          estimated_monthly_cost?: number | null
          id?: string
          instance_types?: string[] | null
          node_desired_size?: number | null
          node_max_size?: number | null
          node_min_size?: number | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id: string
        }
        Update: {
          cluster_admins?: Json | null
          cluster_endpoint?: string | null
          cluster_name?: string | null
          cluster_version?: string | null
          created_at?: string
          enable_karpenter?: boolean | null
          estimated_monthly_cost?: number | null
          id?: string
          instance_types?: string[] | null
          node_desired_size?: number | null
          node_max_size?: number | null
          node_min_size?: number | null
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
          apps_template_branch: string | null
          apps_template_repo: string | null
          created_at: string
          env_destination_repo: string | null
          env_template_branch: string | null
          env_template_repo: string
          gitops_destination_repo: string | null
          gitops_template_branch: string | null
          gitops_template_repo: string
          id: string
          updated_at: string
          vine_id: string
        }
        Insert: {
          apps_destination_repo?: string | null
          apps_template_branch?: string | null
          apps_template_repo?: string | null
          created_at?: string
          env_destination_repo?: string | null
          env_template_branch?: string | null
          env_template_repo?: string
          gitops_destination_repo?: string | null
          gitops_template_branch?: string | null
          gitops_template_repo?: string
          id?: string
          updated_at?: string
          vine_id: string
        }
        Update: {
          apps_destination_repo?: string | null
          apps_template_branch?: string | null
          apps_template_repo?: string | null
          created_at?: string
          env_destination_repo?: string | null
          env_template_branch?: string | null
          env_template_repo?: string
          gitops_destination_repo?: string | null
          gitops_template_branch?: string | null
          gitops_template_repo?: string
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
      vine_topics: {
        Row: {
          created_at: string
          estimated_monthly_cost: number | null
          id: string
          name: string
          status: Database["public"]["Enums"]["component_status"]
          status_message: string | null
          subscriptions: Json | null
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
          subscriptions?: Json | null
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
          subscriptions?: Json | null
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
      vine_vpc: {
        Row: {
          allowed_cidr_blocks: string[] | null
          created_at: string
          estimated_monthly_cost: number | null
          id: string
          provision_vpc: boolean
          single_nat_gateway: boolean | null
          status: Database["public"]["Enums"]["component_status"]
          status_message: string | null
          updated_at: string
          vine_id: string
          vpc_cidr: string | null
          vpc_id: string | null
        }
        Insert: {
          allowed_cidr_blocks?: string[] | null
          created_at?: string
          estimated_monthly_cost?: number | null
          id?: string
          provision_vpc?: boolean
          single_nat_gateway?: boolean | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id: string
          vpc_cidr?: string | null
          vpc_id?: string | null
        }
        Update: {
          allowed_cidr_blocks?: string[] | null
          created_at?: string
          estimated_monthly_cost?: number | null
          id?: string
          provision_vpc?: boolean
          single_nat_gateway?: boolean | null
          status?: Database["public"]["Enums"]["component_status"]
          status_message?: string | null
          updated_at?: string
          vine_id?: string
          vpc_cidr?: string | null
          vpc_id?: string | null
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
      vines: {
        Row: {
          aws_account_id: string | null
          aws_region: string
          cloud_identity_id: string | null
          created_at: string
          environment_stage: Database["public"]["Enums"]["environment_stage"]
          estimated_monthly_cost: number | null
          id: string
          project_name: string
          status: Database["public"]["Enums"]["vine_status"]
          terraform_version: string
          updated_at: string
          user_id: string
          vineyard_id: string | null
        }
        Insert: {
          aws_account_id?: string | null
          aws_region?: string
          cloud_identity_id?: string | null
          created_at?: string
          environment_stage?: Database["public"]["Enums"]["environment_stage"]
          estimated_monthly_cost?: number | null
          id?: string
          project_name: string
          status?: Database["public"]["Enums"]["vine_status"]
          terraform_version?: string
          updated_at?: string
          user_id?: string
          vineyard_id?: string | null
        }
        Update: {
          aws_account_id?: string | null
          aws_region?: string
          cloud_identity_id?: string | null
          created_at?: string
          environment_stage?: Database["public"]["Enums"]["environment_stage"]
          estimated_monthly_cost?: number | null
          id?: string
          project_name?: string
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
      workers: {
        Row: {
          cloud_identity_id: string | null
          created_at: string | null
          id: string
          last_heartbeat: string | null
          metadata: Json | null
          mode: string
          name: string
          status: string | null
          token_hash: string
          user_id: string
        }
        Insert: {
          cloud_identity_id?: string | null
          created_at?: string | null
          id?: string
          last_heartbeat?: string | null
          metadata?: Json | null
          mode: string
          name: string
          status?: string | null
          token_hash: string
          user_id?: string
        }
        Update: {
          cloud_identity_id?: string | null
          created_at?: string | null
          id?: string
          last_heartbeat?: string | null
          metadata?: Json | null
          mode?: string
          name?: string
          status?: string | null
          token_hash?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workers_cloud_identity_id_fkey"
            columns: ["cloud_identity_id"]
            isOneToOne: false
            referencedRelation: "cloud_identities"
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
          applications_template_repo: string | null
          applications_template_repo_branch: string | null
          aws_account_id: string | null
          aws_region: string | null
          cloud_identity_id: string | null
          cloudfront_waf_enabled: boolean | null
          cluster_admins: Json | null
          cluster_endpoint: string | null
          cluster_name: string | null
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
          env_git_repo: string | null
          env_template_repo: string | null
          env_template_repo_branch: string | null
          environment_stage: string | null
          estimated_monthly_cost: number | null
          gitops_destination_repo: string | null
          gitops_template_repo: string | null
          gitops_template_repo_branch: string | null
          id: string | null
          instance_types: string[] | null
          node_desired_size: number | null
          node_max_size: number | null
          node_min_size: number | null
          project_name: string | null
          selected_vpc_id: string | null
          single_nat_gateway: boolean | null
          status: string | null
          terraform_version: string | null
          updated_at: string | null
          user_id: string | null
          vineyard_id: string | null
          vpc_cidr: string | null
          vpc_status: string | null
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
      agent_heartbeat: {
        Args: { p_cluster_id: string; p_token_hash: string }
        Returns: undefined
      }
      claim_next_job: {
        Args: {
          p_cloud_identity_id?: string
          p_worker_id: string
          p_worker_token_hash: string
        }
        Returns: {
          claimed_at: string | null
          cloud_identity_id: string | null
          cluster_id: string | null
          completed_at: string | null
          config_snapshot: Json
          configuration_hash: string | null
          configuration_id: string | null
          created_at: string | null
          error_message: string | null
          execution_metadata: Json | null
          id: string
          job_type: string
          started_at: string | null
          status: string
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
      fetch_next_provision: {
        Args: { p_cluster_id: string; p_token_hash: string }
        Returns: {
          cluster_id: string
          completed_at: string | null
          config_snapshot: Json
          configuration_hash: string | null
          created_at: string | null
          error_message: string | null
          execution_metadata: Json | null
          id: string
          started_at: string | null
          status: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "provisions"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_configuration_stats: {
        Args: never
        Returns: {
          archived_configs: number
          completed_configs: number
          draft_configs: number
          ecs_configs: number
          eks_configs: number
          failed_configs: number
          has_rds_configs: number
          has_vpc_configs: number
          pending_configs: number
          recent_configs: number
          this_month_configs: number
          total_configs: number
        }[]
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
      insert_provision_log: {
        Args: {
          p_cluster_id: string
          p_log_chunk: string
          p_provision_id: string
          p_stream_type: string
          p_token_hash: string
        }
        Returns: undefined
      }
      recover_stale_jobs: { Args: never; Returns: number }
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
      update_provision_status: {
        Args: {
          p_cluster_id: string
          p_error_message?: string
          p_provision_id: string
          p_status: string
          p_token_hash: string
        }
        Returns: undefined
      }
      worker_heartbeat: {
        Args: { p_worker_id: string; p_worker_token_hash: string }
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
      dynamodb_billing_mode: "PAY_PER_REQUEST" | "PROVISIONED"
      dynamodb_key_type: "S" | "N" | "B"
      dynamodb_table_type: "standard" | "global"
      ecr_tag_mutability: "MUTABLE" | "IMMUTABLE"
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
      integration_category: "git" | "cloud"
      integration_status: "active" | "coming_soon"
      logs_level: "debug" | "info" | "warn" | "error" | "critical"
      vine_status:
        | "DRAFT"
        | "QUEUED"
        | "PROVISIONING"
        | "ACTIVE"
        | "FAILED"
        | "DESTROYING"
        | "DESTROYED"
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
      dynamodb_billing_mode: ["PAY_PER_REQUEST", "PROVISIONED"],
      dynamodb_key_type: ["S", "N", "B"],
      dynamodb_table_type: ["standard", "global"],
      ecr_tag_mutability: ["MUTABLE", "IMMUTABLE"],
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
      ],
      integration_category: ["git", "cloud"],
      integration_status: ["active", "coming_soon"],
      logs_level: ["debug", "info", "warn", "error", "critical"],
      vine_status: [
        "DRAFT",
        "QUEUED",
        "PROVISIONING",
        "ACTIVE",
        "FAILED",
        "DESTROYING",
        "DESTROYED",
      ],
    },
  },
} as const
