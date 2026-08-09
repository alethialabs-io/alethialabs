# Invariants for the Flexible Server.
#
# #1382 shipped because nothing asserted that selecting an engine produced a server of that engine.
# Every resource was gated on `is_postgres` while the module's own variable validation accepted
# "mysql", so a MySQL project planned clean, applied clean, and created nothing. These fail at PLAN
# instead — on the one thing that was silently untrue.

check "requested_engine_was_actually_created" {
  assert {
    condition     = var.engine == "postgres" ? length(azurerm_postgresql_flexible_server.this) == 1 : length(azurerm_mysql_flexible_server.this) == 1
    error_message = "engine is '${var.engine}' but no server of that engine was created — the module would provision nothing and report success."
  }
}

check "exactly_one_engine_is_created" {
  assert {
    condition     = length(azurerm_postgresql_flexible_server.this) + length(azurerm_mysql_flexible_server.this) == 1
    error_message = "Expected exactly one Flexible Server; got ${length(azurerm_postgresql_flexible_server.this)} PostgreSQL and ${length(azurerm_mysql_flexible_server.this)} MySQL."
  }
}

# The endpoint is what a service binding resolves to. A null one is not an error anywhere downstream —
# `resolveBindings` records an unresolved binding and omits the env var — so the workload starts and
# fails on first connect. Catch it here, where it is still a plan.
check "server_endpoint_is_resolvable" {
  assert {
    condition     = var.engine == "postgres" ? azurerm_postgresql_flexible_server.this[0].fqdn != "" : azurerm_mysql_flexible_server.this[0].fqdn != ""
    error_message = "The server produced no FQDN — every service binding to this database would silently resolve to nothing."
  }
}

# MySQL rejects high availability unless storage auto-grow is on. The module forces it, so this
# guards the coupling rather than the input.
#
# The condition is written to be DEGENERATE-SAFE, not merely short-circuit-safe (#1931). `||` does
# not short-circuit on the OpenTofu the runner applies with — every disjunct is evaluated, however
# the left ones resolve — so an INDEX into a count-0 resource is reached and kills the plan:
#
#   fixture: var.engine == "postgres" || !var.high_availability || azurerm_mysql…this[0].storage[0]…
#   1.9.0   (apps/runner/Dockerfile.base TOFU_VERSION, compat matrix `tofu`) → Invalid index
#                                                       "azurerm_mysql_flexible_server.this is empty tuple"
#   1.10.10, 1.12.3                                                          → plans clean
#
# A postgres Flexible Server is the COMMON shape of this module, so on the shipped engine this took
# the whole module down; `keyless_postgres_without_a_cluster_is_refused` reproduces it. The template
# gate never saw it because it ran 1.10.10 — the skew this issue closes.
#
# A splat is safe on a zero-length tuple where an index never is: `this[*]…` yields `[]` without
# evaluating the body, `one([])` is null, and `null == true` is plain `false`. Fail-closed meaning
# is unchanged — an absent or renamed server yields `false`, and this check judges only the
# mysql + HA shape, which by construction has the server.
check "mysql_ha_requires_storage_autogrow" {
  assert {
    condition     = var.engine == "postgres" || !var.high_availability || one(azurerm_mysql_flexible_server.this[*].storage[0].auto_grow_enabled) == true
    error_message = "MySQL high availability requires storage auto-grow; the service rejects the combination otherwise."
  }
}

# MySQL Flexible Server accepts only 5.7, 8.0.21 and 8.4 (azurerm 4.x). The module's own
# `engine_version` default is a PostgreSQL major, so a MySQL config that somehow arrives without a
# version would compose an invalid server — and the API's rejection at apply names the field, not the
# reason. The catalog supplies the right default; this catches the case where it doesn't.
check "mysql_engine_version_is_accepted" {
  assert {
    condition     = var.engine == "postgres" || contains(["5.7", "8.0.21", "8.4"], var.engine_version)
    error_message = "MySQL Flexible Server accepts only 5.7, 8.0.21 or 8.4 — got '${var.engine_version}'."
  }
}
