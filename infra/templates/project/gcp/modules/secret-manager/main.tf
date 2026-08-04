locals {
  secrets_map   = { for s in var.secrets : s.name => s }
  generated_map = { for s in var.secrets : s.name => s if s.generate }
}

resource "google_secret_manager_secret" "secret" {
  for_each = local.secrets_map

  secret_id = "${var.environment}-${var.project_name}-${each.key}"
  project   = var.project_id

  replication {
    auto {}
  }

  labels = merge(var.labels, {
    "secret" = each.key
  })
}

resource "random_password" "generated" {
  for_each = local.generated_map

  length  = each.value.length
  special = each.value.special_chars

  # Rotation handle (parity with aws/modules/awssm-passgen). `keepers` is the only lever
  # random_password offers for re-generating a value: change any entry and the password is replaced,
  # leave it alone and the stored value is stable forever. Absent it a generated secret could only
  # be rotated by destroying the Secret Manager secret itself. A secret with no entry in the map
  # gets `{}` — identical to the previous, keeper-less resource, so every existing project plans
  # unchanged.
  keepers = lookup(var.secret_keepers, each.key, {})
}

resource "google_secret_manager_secret_version" "version" {
  for_each = local.generated_map

  secret      = google_secret_manager_secret.secret[each.key].id
  secret_data = random_password.generated[each.key].result
}
