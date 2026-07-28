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

  # The IAM-auth flag is named DIFFERENTLY per engine, and the two are not interchangeable:
  # PostgreSQL takes the dotted `cloudsql.iam_authentication`, MySQL takes the UNDERSCORED
  # `cloudsql_iam_authentication` (Cloud SQL for MySQL, "IAM authentication"). Copying the Postgres
  # form onto a MySQL instance does not error — Cloud SQL simply never turns IAM auth on, so the
  # instance comes up healthy and every keyless login fails. That silence is why checks.tf gates it.
  database_flags_postgres = var.iam_auth ? [
    { name = "cloudsql.iam_authentication", value = "on" },
  ] : []

  database_flags_mysql = var.iam_auth ? [
    { name = "cloudsql_iam_authentication", value = "on" },
  ] : []

  database_flags = var.engine == "POSTGRES" ? local.database_flags_postgres : local.database_flags_mysql

  # The IAM login name differs by engine, and the OUTPUT must be what the app actually authenticates
  # as — the bootstrap GRANT target and the proxy login both key off it.
  #   PostgreSQL: the SA email minus the ".gserviceaccount.com" suffix  → "sa@project.iam"
  #   MySQL:      Cloud SQL "truncates the @ and the domain name from the ... service account's
  #               email address", so the login is the SA LOCAL PART only → "sa"
  # MySQL additionally requires the login be all lowercase, and caps usernames at 32 characters on
  # 8.0+ (16 on earlier). There is NO remediation for an over-long SA local part — the name must be
  # chosen ≤32 up front, which is why checks.tf asserts it rather than silently truncating here.
  # Truncating would produce a user that exists but is not the identity the app presents.
  app_iam_user_postgres = var.app_iam_sa_email != null ? trimsuffix(var.app_iam_sa_email, ".gserviceaccount.com") : null
  app_iam_user_mysql    = var.app_iam_sa_email != null ? lower(split("@", var.app_iam_sa_email)[0]) : null
  app_iam_user          = var.engine == "POSTGRES" ? local.app_iam_user_postgres : local.app_iam_user_mysql

  engine_map = {
    POSTGRES = "POSTGRES"
    MYSQL    = "MYSQL"
  }

  # `database_version` is a Cloud SQL ENUM token (POSTGRES_16, MYSQL_8_0, MYSQL_5_7), so the version
  # segment separates its parts with UNDERSCORES. Every producer we have emits the human/API form with
  # a DOT — the offline catalog ships "8.0", and the federated picker's parseSqlVersion explicitly
  # converts "8_0" → "8.0" so the console can display it — which composed the invalid "MYSQL_8.0" and
  # made Cloud SQL MySQL unprovisionable by any path (#1381).
  #
  # Normalizing HERE rather than in the tfvars builder makes the module correct for EVERY caller (the
  # console, the e2e harness, a hand-written tfvars), instead of only the path that happens to funnel
  # through Go. The rewrite is safe for both engines: PostgreSQL versions are bare integers today, so
  # it is a no-op, and were a dotted one to appear ("9.6") POSTGRES_9_6 is its correct token too.
  engine_version_token = replace(var.engine_version, ".", "_")

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
  # The version's own separator is normalized to the enum's underscore grain — see
  # local.engine_version_token.
  database_version    = "${local.engine_map[var.engine]}_${local.engine_version_token}"
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
#
# The username form is ENGINE-SPECIFIC (local.app_iam_user, #1505): PostgreSQL takes the SA email
# without the ".gserviceaccount.com" suffix; MySQL truncates the @ and domain outright, so it takes
# the SA local part only, lowercased.
################################################################################

resource "google_sql_user" "app_iam" {
  count    = var.app_iam_sa_email != null ? 1 : 0
  name     = local.app_iam_user
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
