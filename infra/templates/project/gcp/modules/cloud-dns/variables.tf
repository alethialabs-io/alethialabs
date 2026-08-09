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
  description = "DNS domain name, with or without a trailing dot (e.g. example.com). The zone's dnsName is normalised to the FQDN form GCP requires — see main.tf."

  validation {
    # Well-formedness, NOT the trailing dot: the dot is now normalised, so requiring it here would
    # reject every real caller. This catches the shapes normalisation cannot rescue — an empty
    # domain, a leading/doubled dot, whitespace — at PLAN time, with a message naming the variable,
    # rather than as a 400 from the API halfway through an apply.
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\\.?$", var.domain))
    error_message = "domain must be a valid DNS name such as example.com or example.com. (lowercase labels, no leading/doubled dots)."
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
