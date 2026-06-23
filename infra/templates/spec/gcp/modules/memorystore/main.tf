terraform {
  required_version = "~> 1.1"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0, < 7.0"
    }
  }
}

################################################################################
# Locals
################################################################################

locals {
  name_prefix   = "${var.project_name}-${var.environment}"
  instance_name = "${local.name_prefix}-redis"
}

################################################################################
# Memorystore Redis instance
################################################################################

resource "google_redis_instance" "this" {
  name               = local.instance_name
  project            = var.project_id
  region             = var.region
  tier               = var.tier
  memory_size_gb     = var.memory_size_gb
  redis_version      = var.redis_version
  auth_enabled       = var.auth_enabled
  authorized_network = var.network_self_link
  display_name       = "${local.name_prefix} Redis"

  connect_mode            = "PRIVATE_SERVICE_ACCESS"
  transit_encryption_mode = var.transit_encryption ? "SERVER_AUTHENTICATION" : "DISABLED"

  redis_configs = var.redis_configs

  labels = merge(var.labels, {
    environment = var.environment
    managed-by  = "opentofu"
  })

  lifecycle {
    prevent_destroy = false
  }
}
