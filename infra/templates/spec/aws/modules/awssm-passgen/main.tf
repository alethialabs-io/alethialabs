resource "random_password" "password" {
  for_each         = { for secret in var.custom_secrets : secret.secret_name => secret if !lookup(secret, "manual", false) }
  length           = each.value.length
  special          = lookup(each.value, "special", false)
  override_special = lookup(each.value, "override_special", null)
  keepers          = lookup(var.secret_keepers, each.key, {})
}

resource "aws_secretsmanager_secret" "secret" {
  for_each                = { for secret in var.custom_secrets : secret.secret_name => secret }
  name                    = "${var.secret_name_prefix}${each.value.secret_name}${var.secret_name_suffix}"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "version" {
  for_each = { for secret in var.custom_secrets : secret.secret_name => secret }

  secret_id     = aws_secretsmanager_secret.secret[each.key].id
  secret_string = coalesce(
    lookup(each.value, "value", null),
    lookup(each.value, "manual", false) ? "editme" : null,
    try(random_password.password[each.key].result, null)
  )
}

