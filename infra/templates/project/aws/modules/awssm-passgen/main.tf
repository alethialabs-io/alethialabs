resource "random_password" "password" {
  for_each         = { for secret in var.custom_secrets : secret.secret_name => secret if !lookup(secret, "manual", false) }
  length           = each.value.length
  special          = lookup(each.value, "special", false)
  override_special = lookup(each.value, "override_special", null)

  # TWO ways to ask for the same rotation handle, and until #4320 only one of them was read.
  #
  # `var.secret_keepers` is a map keyed by secret name (the root's `custom_secret_keepers`); the
  # `keepers` attribute on the secret object itself is the per-secret form, and it is declared by
  # the root AND by this module's own `custom_secrets` type — so a caller could set it, it type-
  # checked, and `random_password` never saw it. A rotation the caller asked for did not happen.
  #
  # Merged rather than chosen: the per-secret attribute is the more specific of the two, so it wins
  # a key collision. It is `optional(map(string))` with no default, hence null-guarded rather than
  # passed to `merge` directly — `merge(x, null)` is an error. Unset on both sides is `{}`, which is
  # exactly what this line produced before, so no existing secret's keeper set changes.
  keepers = merge(
    lookup(var.secret_keepers, each.key, {}),
    each.value.keepers == null ? {} : each.value.keepers,
  )
}

resource "aws_secretsmanager_secret" "secret" {
  for_each                = { for secret in var.custom_secrets : secret.secret_name => secret }
  name                    = "${var.secret_name_prefix}${each.value.secret_name}${var.secret_name_suffix}"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "version" {
  for_each = { for secret in var.custom_secrets : secret.secret_name => secret }

  secret_id = aws_secretsmanager_secret.secret[each.key].id
  secret_string = coalesce(
    lookup(each.value, "value", null),
    lookup(each.value, "manual", false) ? "editme" : null,
    try(random_password.password[each.key].result, null)
  )
}

