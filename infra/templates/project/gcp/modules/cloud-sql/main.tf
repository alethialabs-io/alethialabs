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
# Cloud SQL instance
#
# NOTE: Private Service Access (the VPC_PEERING global address +
# google_service_networking_connection) is NOT created here any more — it is a VPC-level
# construct shared with Memorystore, so it lives in the vpc-network module. Ordering comes
# from the root module's depends_on = [module.vpc_network].
################################################################################

resource "google_sql_database_instance" "this" {
  name    = local.instance_name
  project = var.project_id
  region  = var.region
  # engine_map[engine] already yields "POSTGRES"/"MYSQL", so engine_version must be the BARE
  # version ("16"), not "POSTGRES_16" — otherwise this composes "POSTGRES_POSTGRES_16" and the
  # API rejects it: Invalid value at 'body.database_version'. (Cloud SQL had never provisioned.)
  database_version    = "${local.engine_map[var.engine]}_${var.engine_version}"
  deletion_protection = var.environment == "production" ? true : false

  settings {
    # Pin the edition explicitly. Left unset, the Cloud SQL API now defaults new instances to
    # ENTERPRISE_PLUS, which REJECTS shared-core/standard tiers: "Invalid Tier (db-f1-micro) for
    # (ENTERPRISE_PLUS) Edition." That made the module's own default tier unusable — Cloud SQL could
    # not be created at all. ENTERPRISE is the edition that supports the standard tier family.
    edition           = var.edition
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

# The default user is ALWAYS a BUILT_IN password user, even when iam_auth is on. Cloud SQL grants a
# BUILT_IN user the `cloudsqlsuperuser` role automatically, so this is the platform's admin login — the
# keyless bootstrap Job (#722) connects as it to grant the app's IAM user its scoped privileges (SQL
# GRANTs the Cloud SQL Admin API can't perform). It is NOT typed CLOUD_IAM_USER: that expects an IAM
# principal email (this name isn't one) and would leave the instance with no password admin to
# bootstrap grants. The APP stays keyless — it uses the separate CLOUD_IAM_SERVICE_ACCOUNT user below.
resource "google_sql_user" "default" {
  name     = "${var.project_name}-user"
  project  = var.project_id
  instance = google_sql_database_instance.this.name
  password = random_password.db_password.result
  type     = "BUILT_IN"
}

################################################################################
# Keyless app database user (#722)
#
# When the root passes the app-workload GSA email, create a CLOUD_IAM_SERVICE_ACCOUNT
# database user for it. The workload (via the Cloud SQL Auth Proxy with --auto-iam-authn)
# then logs in with a short-lived IAM token minted from its Workload Identity — no password.
# Cloud SQL expects the IAM SA username to be the SA email WITHOUT the ".gserviceaccount.com"
# suffix.
################################################################################

resource "google_sql_user" "app_iam" {
  count    = var.app_iam_sa_email != null ? 1 : 0
  name     = trimsuffix(var.app_iam_sa_email, ".gserviceaccount.com")
  project  = var.project_id
  instance = google_sql_database_instance.this.name
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
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
