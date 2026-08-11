# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "instance_id" {
  description = "Id of the Container Registry instance"
  value       = alicloud_cr_ee_instance.this.id
}

output "namespace" {
  description = "Name of the created registry namespace"
  value       = alicloud_cr_ee_namespace.this.name
}

# Keyed by the registry COMPONENT's name — the same key the tfvars emitter used — so a caller can
# look a repository up by the name the user typed, as aws's ecr_repository_urls_map and gcp's
# artifact_registry_urls do.
#
# `<namespace>/<repo>`, NOT a full push URL. A CR EE push URL is
# `<instance>-registry[-vpc].<region>.cr.aliyuncs.com/…`, whose host this module cannot derive: the
# provider exports no domain attribute and the module is not given a region. Emitting a guessed host
# would be worse than emitting none — a caller would push into thin air and find out at runtime.
# Composing it belongs with whoever adds the Alibaba build path.
# Read back off the RESOURCE, not off `var.repos`. It is the only thing a root-level `.tftest.hcl`
# can address to prove the canvas's "Immutable tags" switch reached
# `alicloud_cr_ee_repo.tag_immutability`; echoing the variable back would assert nothing.
output "repository_immutable_tags" {
  description = "Map of repository names to the tag_immutability setting planned on the resource"
  value = {
    for name, repo in alicloud_cr_ee_repo.this :
    name => repo.tag_immutability
  }
}

output "repository_paths" {
  description = "Map of registry component names to their <namespace>/<repository> path"
  value = {
    for name, repo in alicloud_cr_ee_repo.this :
    name => "${repo.namespace}/${repo.name}"
  }
}

# Read back off the RESOURCE, like repository_immutable_tags above, and for the same reason: it is
# the only thing a root-level `.tftest.hcl` can address to prove the canvas's "Vulnerability
# scanning" switch planned a real REPO-scoped rule. Keyed by the registry component's name; a
# repository whose switch is off has NO entry — the OFF position is the absence of the rule, so
# the test asserts emptiness rather than a value.
output "repository_scan_rules" {
  description = "Map of repository names to the scan rule planned on alicloud_cr_scan_rule (scope, trigger, type, targets)"
  value = {
    for name, rule in alicloud_cr_scan_rule.this :
    name => {
      scan_scope   = rule.scan_scope
      trigger_type = rule.trigger_type
      scan_type    = rule.scan_type
      repo_names   = rule.repo_names
    }
  }
}
