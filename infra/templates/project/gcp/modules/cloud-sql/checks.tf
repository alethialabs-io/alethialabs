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
