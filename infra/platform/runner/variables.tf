variable "region" {
  type        = string
  description = "AWS region for this runner."
}

variable "name_prefix" {
  type        = string
  description = "Prefix for all resource names (e.g. runner-dev)."
}

variable "image" {
  type        = string
  default     = "ghcr.io/alethialabs-io/runner"
  description = "Container image (without tag)."
}

variable "runner_version" {
  type        = string
  default     = "latest"
  description = "Image tag to deploy."
}

variable "alethia_url" {
  type        = string
  default     = "https://adp.prod.itgix.eu"
  description = "Alethia web origin URL."
}

variable "alethia_api_secret" {
  type        = string
  sensitive   = true
  description = "Secret for authenticating with the Alethia API (runner registration)."
}

variable "runner_mode" {
  type        = string
  default     = "cloud-hosted"
  description = "self-hosted: runner uses native AWS permissions. cloud-hosted: runner assumes roles into customer accounts."

  validation {
    condition     = contains(["self-hosted", "cloud-hosted"], var.runner_mode)
    error_message = "runner_mode must be self-hosted or cloud-hosted."
  }
}

variable "infracost_api_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Infracost API key for cost estimation during plan jobs."
}

variable "storage_endpoint" {
  type        = string
  default     = ""
  description = "S3-compatible endpoint for Terraform state storage."
}

variable "storage_region" {
  type        = string
  default     = "us-east-1"
  description = "Region for the S3 state backend."
}

variable "storage_access_key_id" {
  type        = string
  sensitive   = true
  description = "S3 access key ID for Terraform state."
}

variable "storage_secret_access_key" {
  type        = string
  sensitive   = true
  description = "S3 secret access key for Terraform state."
}

variable "secrets_recovery_window_days" {
  type        = number
  default     = 0
  description = "Days before a deleted secret is permanently removed. 0 = immediate (dev only), 7-30 for production."

  validation {
    condition     = var.secrets_recovery_window_days == 0 || (var.secrets_recovery_window_days >= 7 && var.secrets_recovery_window_days <= 30)
    error_message = "Must be 0 (immediate) or between 7 and 30 days."
  }
}
