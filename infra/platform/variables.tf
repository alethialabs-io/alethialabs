# ---------- Global ----------

variable "project_name" {
  type    = string
  default = "runner"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "nodes" {
  type = map(object({
    region      = string
    alethia_url = string
  }))
  description = "Map of node deployments. Key is the tendril name, value specifies region and Alethia instance."
  default = {
    "prod-eu-west-1" = {
      region      = "eu-west-1"
      alethia_url = "https://adp.prod.itgix.eu"
    }
  }
}

variable "worker_mode" {
  type    = string
  default = "cloud-hosted"

  validation {
    condition     = contains(["self-hosted", "cloud-hosted"], var.worker_mode)
    error_message = "Must be self-hosted or cloud-hosted."
  }
}

variable "alethia_api_secret" {
  type        = string
  sensitive   = true
  description = "Secret for authenticating with the Alethia API (tendril registration + releases)."
}

variable "image" {
  type    = string
  default = "ghcr.io/alethialabs-io/runner"
}

variable "node_version" {
  type    = string
  default = "latest"
}

variable "infracost_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

# ---------- ECR (eu-west-1 only) ----------

variable "ecr_image_tag_mutability" {
  type    = string
  default = "MUTABLE"

  validation {
    condition     = contains(["MUTABLE", "IMMUTABLE"], var.ecr_image_tag_mutability)
    error_message = "Must be MUTABLE or IMMUTABLE."
  }
}

variable "ecr_force_delete" {
  type    = bool
  default = false
}

# ---------- Shared tendril settings ----------

variable "secrets_recovery_window_days" {
  type    = number
  default = 0

  validation {
    condition     = var.secrets_recovery_window_days == 0 || (var.secrets_recovery_window_days >= 7 && var.secrets_recovery_window_days <= 30)
    error_message = "Must be 0 or 7-30."
  }
}

# ---------- Supabase S3 state backend (passed to tendril containers) ----------

variable "supabase_s3_endpoint" {
  type    = string
  default = ""
}

variable "supabase_s3_region" {
  type    = string
  default = "eu-north-1"
}

variable "supabase_storage_key_id" {
  type      = string
  sensitive = true
}

variable "supabase_storage_secret_key" {
  type      = string
  sensitive = true
}

# ---------- Supabase API (for Lambda scaler) ----------

variable "supabase_url" {
  type        = string
  description = "Supabase project URL (for Lambda scaler)."
}

variable "supabase_service_role_key" {
  type        = string
  sensitive   = true
  description = "Supabase service role key (for Lambda scaler)."
}
