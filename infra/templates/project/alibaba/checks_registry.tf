# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Container Registry (CR Enterprise Edition) invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.


# CR provisioning must be REAL. Until #1837 this module created a PAID Enterprise Edition
# subscription and a namespace and no repository at all — a registry with nowhere to push, billed
# monthly. `provision_cr` with an empty `cr_repos` reproduces exactly that shape, so it is refused:
# the emitter (packages/core/cloud/alibaba_provider.go buildCRRepos) supplies one entry per native
# registry component, and a true flag with no entries is a broken caller.
check "cr_repos_present_when_provisioned" {
  assert {
    condition     = !var.provision_cr || length(var.cr_repos) > 0
    error_message = "provision_cr is true but cr_repos is empty — a paid CR Enterprise Edition instance would be created with no repository to push to; the tfvars emitter must supply one entry per native registry component."
  }
}


# The map KEY becomes the repository name, so it has to be legal for one. Alibaba requires a CR
# repository name of lowercase letters, digits and separators, 1-64 characters. The canvas already
# restricts a registry name to lowercase alphanumerics and hyphens; a snapshot arriving from the CLI
# or the API does not, and a bad name is far cheaper to reject here than mid-apply against a
# subscription that has already been bought.
check "cr_repo_names_valid" {
  assert {
    condition = alltrue([
      for name, _ in var.cr_repos : can(regex("^[a-z0-9]+([._-][a-z0-9]+)*$", name)) && length(name) <= 64
    ])
    error_message = "cr_repos contains an invalid repository name (lowercase alphanumerics with single ._- separators, at most 64 characters)."
  }
}
