################################################################################
# General
################################################################################

variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "environment" {
  type        = string
  description = "Environment name (e.g. dev, staging, production)"
}

variable "project_name" {
  type        = string
  description = "Name of the project, used in resource naming"
}

################################################################################
# Cloud DNS
################################################################################

variable "zone_name" {
  type        = string
  description = "Name for the DNS managed zone resource"
}

variable "domain" {
  type        = string
  description = "DNS domain name. Must end with a trailing dot (e.g. example.com.)"
}

variable "managed_certificate" {
  type        = bool
  description = "Whether to create a Google-managed SSL certificate for the domain"
  default     = false
}

################################################################################
# Labels
################################################################################

variable "labels" {
  type        = map(string)
  description = "Labels to apply to all resources"
  default     = {}
}
