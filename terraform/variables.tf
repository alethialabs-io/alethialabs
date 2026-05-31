variable "project_name" {
  type    = string
  default = "grape-worker"
}

variable "region" {
  type    = string
  default = "eu-west-1"
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

variable "worker_id" {
  type        = string
  description = "Worker ID from grape worker register."
}

variable "worker_token" {
  type        = string
  sensitive   = true
  description = "Worker token from grape worker register."
}

variable "trellis_url" {
  type    = string
  default = "https://adp.prod.itgix.eu"
}

variable "grape_version" {
  type    = string
  default = "latest"
}

variable "infracost_api_key" {
  type        = string
  sensitive   = true
  description = "Infracost API key for cost estimation during plan jobs."
  default     = ""
}

variable "vpc_id" {
  type        = string
  description = "VPC where the Fargate task will run."
}

variable "subnet_ids" {
  type        = list(string)
  description = "Subnets for the Fargate task (must have internet access)."
}
