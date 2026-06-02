# ---------- Global ----------

variable "project_name" {
  type    = string
  default = "tendril"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "aws_account_id" {
  type = string
}

variable "worker_mode" {
  type        = string
  default     = "self-hosted"
  description = "self-hosted: worker uses native AWS permissions. cloud-hosted: worker assumes roles into customer accounts."

  validation {
    condition     = contains(["self-hosted", "cloud-hosted"], var.worker_mode)
    error_message = "worker_mode must be self-hosted or cloud-hosted."
  }
}

variable "trellis_url" {
  type    = string
  default = "https://adp.prod.itgix.eu"
}

variable "image" {
  type        = string
  default     = "ghcr.io/bobikenobi12/tendril"
  description = "Container image (without tag). Shared across all regions."
}

variable "tendril_version" {
  type    = string
  default = "latest"
}

variable "infracost_api_key" {
  type        = string
  sensitive   = true
  description = "Infracost API key for cost estimation during plan jobs."
  default     = ""
}

# ---------- ECR (eu-west-1 only) ----------

variable "ecr_image_tag_mutability" {
  type        = string
  default     = "IMMUTABLE"
  description = "Image tag mutability. Use MUTABLE for dev (allows :latest overwrites), IMMUTABLE for production."

  validation {
    condition     = contains(["MUTABLE", "IMMUTABLE"], var.ecr_image_tag_mutability)
    error_message = "Must be MUTABLE or IMMUTABLE."
  }
}

variable "ecr_force_delete" {
  type        = bool
  default     = false
  description = "Allow terraform destroy to delete ECR repo with images. true for dev, false for production."
}

# ---------- Shared worker settings ----------

variable "secrets_recovery_window_days" {
  type        = number
  default     = 7
  description = "Days before a deleted secret is permanently removed. 0 = immediate (dev only), 7-30 for production."

  validation {
    condition     = var.secrets_recovery_window_days == 0 || (var.secrets_recovery_window_days >= 7 && var.secrets_recovery_window_days <= 30)
    error_message = "Must be 0 (immediate) or between 7 and 30 days."
  }
}

variable "assign_public_ip" {
  type        = bool
  default     = true
  description = "Assign public IP to Fargate tasks. true for public subnets, false for private subnets with NAT gateway."
}

# ---------- Supabase S3 state backend (passed to worker containers) ----------

variable "supabase_s3_endpoint" {
  type        = string
  default     = "https://egzejziajjmjmdjplmii.storage.supabase.co/storage/v1/s3"
  description = "Supabase S3-compatible endpoint for Terraform state storage."
}

variable "supabase_s3_region" {
  type        = string
  default     = "eu-north-1"
  description = "Region for the Supabase S3 state backend."
}

variable "supabase_storage_key_id" {
  type        = string
  sensitive   = true
  description = "Supabase Storage S3 access key ID."
}

variable "supabase_storage_secret_key" {
  type        = string
  sensitive   = true
  description = "Supabase Storage S3 secret access key."
}

# ---------- Supabase API (for Lambda scaler) ----------

variable "supabase_url" {
  type        = string
  description = "Supabase project URL (e.g. https://xyz.supabase.co)."
}

variable "supabase_service_role_key" {
  type        = string
  sensitive   = true
  description = "Supabase service role key (server-side, bypasses RLS). Used by the scaler Lambda."
}

# ---------- eu-west-1 worker ----------

variable "eu_west_1_vpc_id" {
  type        = string
  description = "VPC ID in eu-west-1."
}

variable "eu_west_1_subnet_ids" {
  type        = list(string)
  description = "Subnets in eu-west-1 (must have internet access)."
}

variable "eu_west_1_worker_id" {
  type        = string
  description = "Worker ID for the eu-west-1 worker."
}

variable "eu_west_1_worker_token" {
  type        = string
  sensitive   = true
  description = "Worker token for the eu-west-1 worker."
}

# ---------- eu-central-1 worker ----------

variable "eu_central_1_vpc_id" {
  type        = string
  description = "VPC ID in eu-central-1."
}

variable "eu_central_1_subnet_ids" {
  type        = list(string)
  description = "Subnets in eu-central-1 (must have internet access)."
}

variable "eu_central_1_worker_id" {
  type        = string
  description = "Worker ID for the eu-central-1 worker."
}

variable "eu_central_1_worker_token" {
  type        = string
  sensitive   = true
  description = "Worker token for the eu-central-1 worker."
}
