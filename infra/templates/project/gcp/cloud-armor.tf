module "cloud_armor" {
  source = "./modules/cloud-armor"
  count  = var.cloud_armor_enabled ? 1 : 0

  project_id   = var.project_id
  environment  = var.environment
  project_name = var.project_name

  rules = var.cloud_armor_rules
  # The root has declared `cloud_armor_default_action` since the template shipped and never passed
  # it anywhere; the module hardcoded deny(403), so the policy denied everything whatever the
  # operator chose (#1826). Harmless while the policy was attached to nothing — an outage the moment
  # it fronts the platform ingress, which is what this PR makes it do.
  default_action = var.cloud_armor_default_action

  labels = local.gcp_default_labels
}
