################################################################################
# Private Repository
################################################################################
output "repository_names" {
  description = "List of ECR repository names"
  value       = [for m in values(module.ecr) : m.repository_name]
}
output "repository_urls_map" {
  description = "Map of repository URLs keyed by logical name"
  value       = { for k, m in module.ecr : k => m.repository_url }
}

# The lifecycle policy document actually handed to the upstream module. Exposed so
# checks_account_and_ecr.tftest.hcl can assert it against AWS's own >= 100-character
# constraint — the one that rejected an empty document mid-apply and that neither
# `tofu validate` nor a plan diff would have caught. It renders with no repositories
# configured, so the assertion costs nothing.
output "lifecycle_policy_document" {
  description = "The ECR lifecycle policy JSON passed to the upstream module (the template default unless overridden)."
  value       = local.lifecycle_policy
}

# The image settings actually handed to the upstream module, PER REPOSITORY, exposed for the same
# reason as the lifecycle document above: checks_registry.tftest.hcl asserts them in BOTH switch
# positions, and a module input is not reachable from a test any other way.
#
# Said plainly, because the difference matters: this is the value crossing the boundary INTO
# terraform-aws-modules/ecr, not the attribute on `aws_ecr_repository` — a test cannot address a
# resource inside a module, and this one is a third-party module besides. The other half (that the
# upstream module puts these on `repository_image_tag_mutability` / `repository_image_scan_on_push`,
# which are its own passthroughs to the resource) is ecr.tf above, and is what the offer-parity
# guard's template check reads statically. The half this test owns is the one no static reader can
# have: that the two positions of the switch produce DIFFERENT values, and which value is which.
#
# Keyed by repository since #1811's follow-up. A single pair of scalars here could not express the
# defect that mattered — two repositories asking for OPPOSITE settings — so a test written against
# it would have gone on passing while both got the same answer.
output "image_settings" {
  description = "The image-scanning and tag-mutability settings passed to the upstream ECR module, keyed by logical repository name."
  value = {
    for k, v in local.ecr_input : k => {
      image_tag_mutability = v.immutable_tags ? "IMMUTABLE" : "MUTABLE"
      image_scan_on_push   = v.vulnerability_scanning
    }
  }
}