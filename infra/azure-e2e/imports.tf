# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# ── Adopt the hand-made `gh-oidc-env` federated credential (#2462) ────────────────────────────
#
# On 2026-08-24 the `e2e-dev` environment trust was widened BY HAND, with the maintainer's
# authorization: `az ad app federated-credential create` added `gh-oidc-env` to the e2e
# application, with exactly the name and subject `azuread_application_federated_identity_credential
# .github["env"]` (main.tf) generates from `e2e_github_environment = "e2e-dev"` (terraform.tfvars).
#
# The live object exists; the state entry does not. A hand-made change that is an ATTRIBUTE of a
# resource already in state is picked up by refresh; one that is its OWN resource is invisible to
# refresh — so without this block the next plan says `create` and the apply fails on a duplicate
# credential name. With it, the next plan says `import` and nothing else for this address.
#
# The ID is the azuread 3.x import shape,
#   /applications/<application OBJECT id>/federatedIdentityCredential/<credential id>
# with both values as read live on 2026-08-25 and recorded in
# docs/testing/e2e-federation-apply-runbook.md §3. `eb0f6831-…` is the application's OBJECT id,
# not its client id (the client id — the E2E_AZURE_CLIENT_ID repo variable — is `ea04b39b-…`);
# the ID's first segment must be the object id, and it is now taken from `azuread_application.e2e`
# rather than written in (see the `id` line). The credential id was not re-read for this PR — no
# Azure call was made — so if it is stale the import fails loudly at plan time rather than
# adopting the wrong object.
#
# `for_each` keys the import on the SAME condition that creates the resource: with
# `e2e_github_environment = ""` there is no `github["env"]` instance, and an unconditional import
# targeting it would fail the plan ("configuration for import target does not exist").
#
# Once this has been applied the block is inert — an import whose target is already in state is a
# no-op — and it can be deleted in any later PR. Keep it until then: this stack has NO remote
# state (#4903), so "applied" is known only to whoever holds the local state file.
import {
  for_each = contains(keys(local.federated_subjects), "env") ? toset(["env"]) : toset([])

  to = azuread_application_federated_identity_credential.github[each.key]
  # The application segment is DERIVED from the application this stack manages, not written in.
  # With the application in state this renders `/applications/eb0f6831-…`, exactly as before. With
  # it NOT in state (the local state file lost — #4903's risk) its id is unknown at plan time, so
  # the plan REFUSES rather than adopting the live credential under a config that would then force
  # a replacement — which, applied, deletes the live `e2e-dev` credential.
  id = "${azuread_application.e2e.id}/federatedIdentityCredential/eae3cf58-1f19-4270-9bb1-7c46e0f94a12"
}
