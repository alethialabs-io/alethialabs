variable "region" {
  type        = string
  description = "AWS region for this worker."
}

variable "name_prefix" {
  type        = string
  description = "Prefix for all resource names (e.g. tendril-dev)."
}

variable "worker_id" {
  type        = string
  description = "Worker ID registered in Trellis."
}

variable "worker_token" {
  type        = string
  sensitive   = true
  description = "Worker authentication token."
}

variable "image" {
  type        = string
  default     = "ghcr.io/bobikenobi12/tendril"
  description = "Container image (without tag)."
}

variable "tendril_version" {
  type        = string
  default     = "latest"
  description = "Image tag to deploy."
}

variable "vpc_id" {
  type        = string
  description = "VPC where the Fargate task will run."
}

variable "subnet_ids" {
  type        = list(string)
  description = "Subnets for the Fargate task (must have internet access)."
}

variable "trellis_url" {
  type        = string
  default     = "https://adp.prod.itgix.eu"
  description = "Trellis web origin URL."
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

variable "infracost_api_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Infracost API key for cost estimation during plan jobs."
}

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
