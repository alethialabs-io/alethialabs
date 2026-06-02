################################################################################
# General
################################################################################

variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type        = string
  description = "GCP region to deploy resources"
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
# Networking
################################################################################

variable "network_cidr" {
  type        = string
  description = "Primary CIDR range for the private subnet"
  default     = "10.0.0.0/16"
}

variable "single_cloud_nat" {
  type        = bool
  description = "Use a single Cloud NAT instead of one per zone. Suitable for dev/test environments"
  default     = false
}

variable "gke_cluster_name" {
  type        = string
  description = "Name of the GKE cluster, used for subnet secondary range naming"
}

variable "pod_ip_range" {
  type        = string
  description = "Secondary IP range for GKE pods"
  default     = "10.1.0.0/16"
}

variable "service_ip_range" {
  type        = string
  description = "Secondary IP range for GKE services"
  default     = "10.2.0.0/20"
}

################################################################################
# Labels
################################################################################

variable "labels" {
  type        = map(string)
  description = "Labels to apply to all resources"
  default     = {}
}
