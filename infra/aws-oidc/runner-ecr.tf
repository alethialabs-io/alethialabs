# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# #3438 — the registry `alethia-runner-release-deployer` has always been allowed to push to,
# and which nothing has ever created.
#
# ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────
#
# `roles.tf` grants `ecr:PutImage` (and the six layer verbs) on
# `arn:aws:ecr:<runner_aws_region>:<account>:repository/<runner_ecr_repository>`. A grant is not a
# resource: the name has lived in three places since 53abe279 (2026-06-20) — this stack's variable,
# `.github/workflows/release-runner.yml` and `.github/workflows/deploy-fleet-aws.yml` — and was
# created by none of them. `grep -rn aws_ecr_repository infra` returned only the CUSTOMER project
# template (`infra/templates/project/aws/modules/ecr`), which is a different thing entirely: that
# module builds registries inside a customer's account at provision time.
#
# The cost was silent and total. `release-runner` has run exactly twice, 2026-07-19 and 2026-08-30,
# and both runs died byte-identically:
#
#   ERROR: failed to push …/alethia-runner-dev-runner:latest: unknown: The repository with name
#   'alethia-runner-dev-runner' does not exist in the registry with id '270587882865'
#
# The OIDC assume and `amazon-ecr-login` both succeeded on both runs, so the account and the role
# were right and only the repository was absent.
#
# ── WHY IT LIVES IN THIS STACK ──────────────────────────────────────────────────────────────────
#
# Because this is the stack that already names the thing. `runner_ecr_repository`,
# `runner_aws_region`, `runner_ecs_cluster` and `runner_ecs_service` are all declared here and all
# committed in `terraform.tfvars`, and the IAM grant below is now written against
# `aws_ecr_repository.runner.arn` rather than a re-interpolated string — so the permission and the
# resource cannot name different repositories again. Putting the registry in a new stack would have
# recreated exactly the split that caused this.
#
# It is a maintainer apply, like everything else here: this stack creates IAM (infra/README.md
# invariant 4 — `tofu apply` on infra/ identity stacks is maintainer-only, agents never apply).
#
# ── IF THE APPLY REPORTS RepositoryAlreadyExistsException ───────────────────────────────────────
#
# Then someone created it by hand between the failing run and the apply, and the fix is an import,
# not a rename:  tofu import 'aws_ecr_repository.runner' alethia-runner-dev-runner

resource "aws_ecr_repository" "runner" {
  provider = aws.runner
  name     = var.runner_ecr_repository

  # MUTABLE is required, not a default left alone. `release-runner.yml` re-points `:latest` at
  # every release and `deploy-fleet-aws.yml` re-points it on every manual dev push; IMMUTABLE
  # would reject the second push of `:latest` and reintroduce this same failure with a different
  # message. The semver tag is the one a deployment should ever pin, and release-please only ever
  # mints each one once.
  image_tag_mutability = "MUTABLE"

  # The runner image carries the tofu binary and every provider plugin it provisions with, so a
  # CVE in it is a CVE in the thing that holds customer cloud credentials. Scan every push.
  image_scanning_configuration {
    scan_on_push = true
  }

  # SSE-S3, matching the tofu-state bucket's accepted posture. The contents are the runner image
  # we also publish PUBLICLY to ghcr.io/alethialabs-io/runner — there is no secret here for a CMK
  # to protect, and a customer-managed key on a registry every ECS task pull must decrypt adds a
  # per-pull KMS dependency for nothing.
  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = local.tags

  # This registry is what the managed Fargate fleet pulls from, and every runner release ever
  # published lands in it. `force_delete` is deliberately left at its `false` default, so AWS
  # already refuses to delete it while it holds images — but that is a refusal at APPLY time, and
  # `name` forces replacement, so a careless rename of `runner_ecr_repository` would plan a
  # destroy-and-create that empties the registry. `prevent_destroy` turns both into a PLAN-time
  # refusal, which is the correct weight: retiring or renaming this repository should be a code
  # edit someone reviews, not a side effect of editing a variable.
  lifecycle {
    prevent_destroy = true
  }
}

# Every release re-points `:latest` at a new manifest, which leaves the previous one UNTAGGED and
# billing for storage forever. Nothing else in this repository ever prunes it. Fourteen days is a
# rollback window measured against release cadence, not a guess at a safe number: the semver tags
# are never expired by this policy, so what ages out is only the manifest that `:latest` moved off.
resource "aws_ecr_lifecycle_policy" "runner" {
  provider   = aws.runner
  repository = aws_ecr_repository.runner.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Expire untagged manifests 14 days after push (orphaned by a :latest re-point)."
      selection = {
        tagStatus   = "untagged"
        countType   = "sinceImagePushed"
        countUnit   = "days"
        countNumber = 14
      }
      action = {
        type = "expire"
      }
    }]
  })
}

# ── Invariants ─────────────────────────────────────────────────────────────────────────────────

check "runner_ecr_is_in_the_fleet_region" {
  assert {
    # `release-runner.yml` hardcodes `AWS_REGION: eu-west-1` and reaches the registry through
    # `amazon-ecr-login`, which resolves the account's registry IN THE CONFIGURED REGION. A
    # repository created anywhere else is invisible to the push and fails with the same 404 this
    # file exists to end — so assert the ARN's region against the variable the role's grant uses.
    condition     = split(":", aws_ecr_repository.runner.arn)[3] == var.runner_aws_region
    error_message = "the runner ECR repository must be created in runner_aws_region — release-runner.yml logs into the registry in that region, and a repository in any other region reads to the push as 'does not exist'."
  }
}
