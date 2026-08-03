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

variable "certificate_domains" {
  type        = list(string)
  description = <<-EOT
    Hostnames the Google-managed SSL certificate covers. Every one of them MUST end up resolving
    to the load balancer the certificate is attached to: Google validates each name before the
    certificate leaves PROVISIONING, and a single name that never resolves holds the entire
    certificate in FAILED_NOT_VISIBLE. Pass only names something actually serves — the caller
    knows which those are, this module does not.
  EOT
  default     = []

  validation {
    condition     = !var.managed_certificate || length(var.certificate_domains) > 0
    error_message = "certificate_domains must name at least one hostname when managed_certificate is true — a certificate covering nothing can never go ACTIVE."
  }
}

################################################################################
# Labels
################################################################################

variable "labels" {
  type        = map(string)
  description = "Labels to apply to all resources"
  default     = {}
}
