# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The `alethia-e2e-nightly` RAM role — the identity the T2 real-cloud nightly (.github/workflows/
# e2e-nightly.yml, `alibaba` provider) assumes via AssumeRoleWithOIDC to provision + tear down a
# genuine, ephemeral ACK estate from infra/templates/project/alibaba (ACK + VPC + NAT + SLB/ALB +
# CSI disks + …).
#
# A provisioning identity is inherently broad — you cannot enumerate a least-privilege action list
# for "stand up + tear down a whole ACK estate" without it breaking on the next template change. So
# the model mirrors the AWS twin (infra/aws-oidc/e2e-nightly.tf): DEFENSE BY GUARDRAIL.
#
#   1. A ref-bound OIDC trust — only Actions runs whose OIDC `sub` is EXACTLY
#      `repo:<repo>:ref:refs/heads/<e2e_github_branch>` (StringEquals, never StringLike) can assume
#      it. PRs, forks and sibling branches cannot. `oidc:aud` + `oidc:iss` are pinned too. This is
#      the same non-wildcard binding controls_alibaba.go ALI-OIDC-001 enforces on RRSA trusts.
#   2. A least-privilege Custom policy — service-scoped (ACK/ECS/VPC/SLB/ALB + `tag:*` for teardown
#      + the non-escalating service-linked-role grant), NEVER `*:*` and NEVER an admin System policy
#      (AdministratorAccess / AliyunRAMFullAccess) — the exact hard-fails ALI-LEASTPRIV-001 blocks.
#
# KNOWN LIMITATION (documented, mirrors the AWS README): Alibaba RAM has no universal region
# condition key (no `aws:RequestedRegion` analogue) and no permissions-boundary mechanism, so the
# role cannot be region-fenced or boundary-capped in-policy. The real wall is therefore the
# ref-bound OIDC trust ("who can run the nightly" == "who can push the e2e branch"), plus the
# region-locked sweeper. See README "Known limitation".

locals {
  # EXACT, non-wildcard GitHub Actions subject — only the e2e branch's runs. StringEquals over this
  # single exact string: no `*`, no StringLike, so no sibling repo/branch/PR/fork can match.
  e2e_sub = "repo:${var.github_repo}:ref:refs/heads/${var.e2e_github_branch}"

  # A DISPATCH that declares the branch-restricted GitHub environment federates under a different
  # exact subject — GitHub replaces the `ref:` form with `environment:` in `sub`. RAM `StringEquals`
  # takes a VALUE LIST (the same shape infra/aws-oidc uses for local.e2e_subs), so this ADDS a second
  # exact string rather than relaxing the first. Empty environment ⇒ the list is the single ref subject
  # and the trust document is byte-identical to before.
  #
  # What pins the BRANCH is the environment's own deployment-branch policy, not this document — which
  # says only "that environment". That is why the variable's docs refuse to be set for an
  # unrestricted environment.
  e2e_env_sub = var.e2e_github_environment != "" ? "repo:${var.github_repo}:environment:${var.e2e_github_environment}" : ""
  e2e_subs    = compact([local.e2e_sub, local.e2e_env_sub])

  # The trust (assume-role) document. Alibaba OIDC federation uses a Federated principal + the
  # `sts:AssumeRole` action (as in alethia-alibaba-setup.sh and what isALIFederatedTrust keys on),
  # and Version "1" RAM documents.
  trust_document = {
    Version = "1"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Federated = [alicloud_ims_oidc_provider.github.arn] }
      Condition = {
        StringEquals = {
          "oidc:iss" = var.github_issuer_url
          "oidc:aud" = var.oidc_audience
          # A LIST: StringEquals over a value list means "any of these exact strings", never a prefix
          # or a wildcard. One entry when no environment is configured.
          "oidc:sub" = local.e2e_subs
        }
      }
    }]
  }

  # Least-privilege provisioning actions — one service wildcard per Alibaba service the alibaba
  # project template creates, PLUS `tag:*` (the teardown sweeper's ListTagResources/TagResources/
  # UntagResources) and the narrow, non-escalating service-linked-role grant ACK/NAT need on first
  # use. Deliberately NO bare `*` action and NO `ram:*` (either would be a hard fail / escalation).
  provision_actions = [
    "cs:*",  # ACK managed clusters + node pools
    "ecs:*", # ECS node instances, cloud disks (CSI pvc-*), security groups
    "vpc:*", # VPC, vSwitch, NAT gateway, EIP, SNAT
    "slb:*", # classic SLB (ACK API-server LB + LoadBalancer Services / CCM)
    "alb:*", # ALB (CCM ingress)
    "eip:*", # Elastic IP (some SDKs address EIP under its own service prefix)
    "tag:*", # teardown: tag discovery + tag/untag (scripts/e2e/alibaba-cleanup.sh)
    # ACK Kubernetes Secrets envelope encryption (#2092). Its absence is why the first real apply
    # failed with `Forbidden.NoPermission … AuthAction: kms:CreateKey … ImplicitDeny` on
    # alicloud_kms_key.ack_secrets (run 31356854945, #2262). One service wildcard, matching every
    # other entry here; the customer-facing connector gets the narrow verb list instead.
    "kms:*",
    "ram:CreateServiceLinkedRole",
    "ram:DeleteServiceLinkedRole",
    "ram:GetServiceLinkedRoleDeletionStatus",
  ]

  provision_document = {
    Version = "1"
    Statement = [{
      Effect   = "Allow"
      Action   = local.provision_actions
      Resource = "*"
    }]
  }
}

resource "alicloud_ram_role" "e2e" {
  role_name   = var.role_name
  description = "OIDC role for the T2 real-cloud nightly (alibaba) - provisions + tears down an ephemeral ACK estate. Ref-bound trust + least-priv Custom policy. See infra/alibaba-e2e/roles.tf."

  assume_role_policy_document = jsonencode(local.trust_document)

  # A long ACK apply must outlive the default 1h session; 2h headroom under the workflow's job cap.
  # The nightly requests the duration it needs at assume time.
  max_session_duration = 7200
}

resource "alicloud_ram_policy" "e2e_provision" {
  policy_name     = "${var.role_name}-provision"
  policy_document = jsonencode(local.provision_document)
  description     = "Least-privilege provisioning grants for the e2e ACK estate (service-scoped, no admin, tag:* for teardown)."
}

resource "alicloud_ram_role_policy_attachment" "e2e_provision" {
  role_name   = alicloud_ram_role.e2e.id
  policy_name = alicloud_ram_policy.e2e_provision.policy_name
  policy_type = "Custom"
}
