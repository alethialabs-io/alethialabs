terraform {
  required_version = "~> 1.1"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0, < 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

################################################################################
# Locals
################################################################################

locals {
  name_prefix   = "${var.project_name}-${var.environment}"
  instance_name = "${local.name_prefix}-sql"
  database_name = "${var.project_name}-${var.environment}"

  database_flags_postgres = var.iam_auth ? [
    { name = "cloudsql.iam_authentication", value = "on" },
  ] : []

  database_flags_mysql = []

  database_flags = var.engine == "POSTGRES" ? local.database_flags_postgres : local.database_flags_mysql

  engine_map = {
    POSTGRES = "POSTGRES"
    MYSQL    = "MYSQL"
  }

  default_port = {
    POSTGRES = 5432
    MYSQL    = 3306
  }

  port = coalesce(var.port, local.default_port[var.engine])
}

################################################################################
# Private IP allocation
################################################################################

resource "google_compute_global_address" "private_ip" {
  name          = "${local.name_prefix}-sql-private-ip"
  project       = var.project_id
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = var.network_self_link
}

resource "google_service_networking_connection" "private_vpc" {
  network                 = var.network_self_link
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip.name]
}

################################################################################
# Cloud SQL instance
################################################################################

resource "google_sql_database_instance" "this" {
  name                = local.instance_name
  project             = var.project_id
  region              = var.region
  database_version    = "${local.engine_map[var.engine]}_${var.engine_version}"
  deletion_protection = var.environment == "production" ? true : false

  depends_on = [google_service_networking_connection.private_vpc]

  settings {
    tier              = var.tier
    disk_size         = var.disk_size
    disk_autoresize   = true
    availability_type = var.high_availability ? "REGIONAL" : "ZONAL"
    disk_type         = "PD_SSD"

    ip_configuration {
      ipv4_enabled                                  = length(var.authorized_networks) > 0
      private_network                               = var.network_self_link
      enable_private_path_for_google_cloud_services = true

      dynamic "authorized_networks" {
        for_each = var.authorized_networks
        content {
          name  = authorized_networks.value.name
          value = authorized_networks.value.value
        }
      }
    }

    backup_configuration {
      enabled                        = var.backup_enabled
      start_time                     = "03:00"
      point_in_time_recovery_enabled = var.engine == "POSTGRES" && var.backup_enabled ? true : false
      transaction_log_retention_days = var.backup_enabled ? min(var.backup_retention_days, 7) : null

      backup_retention_settings {
        retained_backups = var.backup_retention_days
        retention_unit   = "COUNT"
      }
    }

    dynamic "database_flags" {
      for_each = local.database_flags
      content {
        name  = database_flags.value.name
        value = database_flags.value.value
      }
    }

    user_labels = merge(var.labels, {
      environment = var.environment
      managed-by  = "opentofu"
    })
  }
}

################################################################################
# Default database
################################################################################

resource "google_sql_database" "default" {
  name     = local.database_name
  project  = var.project_id
  instance = google_sql_database_instance.this.name
}

################################################################################
# Default user + password
################################################################################

resource "random_password" "db_password" {
  length  = 32
  special = true
}

resource "google_sql_user" "default" {
  name     = "${var.project_name}-user"
  project  = var.project_id
  instance = google_sql_database_instance.this.name
  password = random_password.db_password.result
  type     = var.iam_auth ? "CLOUD_IAM_USER" : "BUILT_IN"
}

################################################################################
# Store credentials in Secret Manager
################################################################################

resource "google_secret_manager_secret" "db_credentials" {
  secret_id = "${local.name_prefix}-sql-credentials"
  project   = var.project_id

  labels = merge(var.labels, {
    environment = var.environment
    managed-by  = "opentofu"
  })

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "db_credentials" {
  secret = google_secret_manager_secret.db_credentials.id

  secret_data = jsonencode({
    host            = google_sql_database_instance.this.private_ip_address
    port            = local.port
    database        = google_sql_database.default.name
    username        = google_sql_user.default.name
    password        = random_password.db_password.result
    connection_name = google_sql_database_instance.this.connection_name
  })
}
