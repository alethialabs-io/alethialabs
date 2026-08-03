# The NAME, not the id or the self link, is what a GKE BackendConfig binds:
# `spec.securityPolicy.name` takes the bare policy name and resolves it inside the cluster's own
# project. The two outputs below carry the fully-qualified forms for anything that needs to address
# the policy across projects (and for a human reading the state), but the attach path reads this one.
output "policy_name" {
  description = "The name of the Cloud Armor security policy — the value a GKE BackendConfig's spec.securityPolicy.name takes"
  value       = google_compute_security_policy.policy.name
}

# Echoes the catch-all rule's action back to the caller. It looks like an identity output and is not
# one: the bug it pins (#1826) was the ROOT never passing `cloud_armor_default_action` down at all
# while the module hardcoded `deny(403)`, so the root variable and the shipped policy disagreed with
# nothing to say so. Asserting this in checks_ingress_armor.tftest.hcl makes that wiring visible to a
# plan-time test, which cannot otherwise reach inside a resource's rule blocks.
output "default_action" {
  description = "The action on the policy's catch-all rule — the value the root's cloud_armor_default_action actually reached"
  value       = var.default_action
}

output "policy_id" {
  description = "The ID of the Cloud Armor security policy"
  value       = google_compute_security_policy.policy.id
}

output "policy_self_link" {
  description = "The self link of the Cloud Armor security policy"
  value       = google_compute_security_policy.policy.self_link
}
