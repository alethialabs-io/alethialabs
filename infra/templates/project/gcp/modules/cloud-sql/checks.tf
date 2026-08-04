# Invariants for the Cloud SQL instance.
#
# `database_version` is composed from two variables, and both of the ways that composition can go
# wrong have already reached production: an engine-prefixed version ("POSTGRES_POSTGRES_16") and a
# dot-separated one ("MYSQL_8.0", #1381). The API's response to either is the same opaque
# "Invalid value at 'body.database_version'", surfaced at APPLY time against a real project.
#
# These assert the composed token instead, at plan time, in the module that owns the grammar.

check "database_version_matches_the_cloud_sql_enum" {
  assert {
    condition     = can(regex("^(POSTGRES|MYSQL)_[0-9]+(_[0-9]+)*$", google_sql_database_instance.this.database_version))
    error_message = "Composed database_version '${google_sql_database_instance.this.database_version}' is not a Cloud SQL enum token (POSTGRES_16, MYSQL_8_0). engine_version must be the bare version — see modules/cloud-sql/variables.tf."
  }
}

# The engine family in the token must be the one the caller actually asked for. Nothing composes it
# from a second source today, but the token is the only place the two meet, and a MySQL instance
# silently created as POSTGRES (or vice versa) is a data-loss-shaped mistake rather than a failed plan.
check "database_version_engine_matches_the_requested_engine" {
  assert {
    condition     = startswith(google_sql_database_instance.this.database_version, "${local.engine_map[var.engine]}_")
    error_message = "database_version '${google_sql_database_instance.this.database_version}' does not belong to the requested engine '${var.engine}'."
  }
}


################################################################################
# Keyless MySQL IAM auth invariants (#1505)
#
# Every failure mode below is SILENT on GCP's side — the instance provisions healthy and only the
# keyless login fails, at runtime, against a real cluster. So each is asserted twice: a `check` block
# to surface it loudly at plan time, and a precondition on terraform_data.mysql_iam_auth_guard to
# actually BLOCK the apply (`check` blocks only warn — they never stop an apply).
################################################################################

# The MySQL IAM flag is `cloudsql_iam_authentication` (underscore); the Postgres dotted form is not a
# synonym. Without it Cloud SQL never enables IAM auth and every token login is rejected.
check "mysql_iam_auth_flag_present" {
  assert {
    condition = !(var.engine == "MYSQL" && var.iam_auth) || contains(
      [for f in local.database_flags : f.name], "cloudsql_iam_authentication"
    )
    error_message = "engine=MYSQL with iam_auth=true but the cloudsql_iam_authentication flag is absent; the instance would accept no IAM logins."
  }
}

# Cloud SQL MySQL truncates the @ and domain, so the login is the SA local part — capped at 32 chars
# on MySQL 8.0+ and required to be all lowercase. There is NO remediation for an over-long local
# part: the SA has to be named ≤32 up front, which is why this fails the plan instead of truncating.
#
# `coalesce` in the MESSAGE, not in the condition. OpenTofu evaluates an error_message EAGERLY —
# whether or not its condition failed — so interpolating `local.app_iam_user` raw broke the plan
# outright on every shape where `app_iam_sa_email` is null:
#   Error: Invalid template interpolation value … local.app_iam_user is null
# and that is not a keyless-only shape: it is EVERY Cloud SQL instance without IAM auth
# (`create_cloud_sql = true, cloud_sql_iam_auth = false`), which could not plan at all. Verified
# against origin/dev, so it predates #1772 — found here because adding `var.provision_gke` to
# locals.enable_app_db_iam makes a cluster-less keyless request produce exactly that null. The
# conditions are unchanged and still fail-closed; only the message is made renderable.
#
# The CONDITION needed the same treatment for the same reason, one version down. `||` does not
# short-circuit on OpenTofu 1.9.0 — the version the runner ships (apps/runner/Dockerfile.base
# TOFU_VERSION, compat matrix `tofu`) — so `length(local.app_iam_user)` is reached even when the
# left disjunct is a known `true`, and a POSTGRES instance died with "argument must not be null"
# exactly like the message did. See gcp/checks_data.tf for the measured version table (#1920).
# `try(..., false)` keeps the fail-closed meaning: a null or renamed local yields `false`, and the
# disjunction still evaluates to `true` on the shapes this check does not judge.
check "mysql_iam_user_fits_mysql_limits" {
  assert {
    condition = !(var.engine == "MYSQL" && var.app_iam_sa_email != null) || try(
      length(local.app_iam_user) <= 32 && local.app_iam_user == lower(local.app_iam_user), false
    )
    error_message = "MySQL IAM login '${coalesce(local.app_iam_user, "(none)")}' is longer than 32 characters or not lowercase; rename the app service account (its local part IS the login)."
  }
}

# IAM database authentication is unsupported on MySQL 5.6 and the username cap drops to 16 before
# 8.0, so keyless on an older MySQL is not a degraded mode — it simply does not work.
check "mysql_iam_auth_requires_8_0" {
  assert {
    condition = !(var.engine == "MYSQL" && var.iam_auth) || try(
      tonumber(split("_", local.engine_version_token)[0]) >= 8, false
    )
    error_message = "engine=MYSQL with iam_auth=true requires MySQL >= 8.0 (got '${var.engine_version}'); IAM database authentication is unsupported on earlier versions."
  }
}

# Fail-closed apply gate for all three (see the block comment above).
resource "terraform_data" "mysql_iam_auth_guard" {
  lifecycle {
    precondition {
      condition = !(var.engine == "MYSQL" && var.iam_auth) || contains(
        [for f in local.database_flags : f.name], "cloudsql_iam_authentication"
      )
      error_message = "GCP-MYSQL-IAM-001: engine=MYSQL with iam_auth=true but the cloudsql_iam_authentication flag is absent. Apply blocked fail-closed — the instance would provision healthy and reject every keyless login."
    }

    precondition {
      condition = !(var.engine == "MYSQL" && var.app_iam_sa_email != null) || try(
        length(local.app_iam_user) <= 32 && local.app_iam_user == lower(local.app_iam_user), false
      )
      # coalesce for the same reason as the check above — a message that cannot render turns a
      # passing precondition into a failed plan. The `try()` on the condition is the 1.9.0
      # non-short-circuit fix; see the check of the same name above.
      error_message = "GCP-MYSQL-IAM-002: MySQL IAM login '${coalesce(local.app_iam_user, "(none)")}' exceeds 32 characters or is not lowercase. Apply blocked fail-closed — Cloud SQL MySQL truncates the @ and domain, so the service account's local part IS the login and there is no remediation but renaming it."
    }

    precondition {
      condition = !(var.engine == "MYSQL" && var.iam_auth) || try(
        tonumber(split("_", local.engine_version_token)[0]) >= 8, false
      )
      error_message = "GCP-MYSQL-IAM-003: engine=MYSQL with iam_auth=true requires MySQL >= 8.0 (got '${var.engine_version}'). Apply blocked fail-closed — IAM database authentication is unsupported on earlier versions."
    }
  }
}
