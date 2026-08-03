locals {
  aws_regions_short = {
    "ap-east-1"      = "ae1"
    "ap-northeast-1" = "an1"
    "ap-northeast-2" = "an2"
    "ap-northeast-3" = "an3"
    "ap-south-1"     = "as0"
    "ap-southeast-1" = "as1"
    "ap-southeast-2" = "as2"
    "ca-central-1"   = "cc1"
    "eu-central-1"   = "ec1"
    "eu-north-1"     = "en1"
    "eu-south-1"     = "es1"
    "eu-west-1"      = "ew1"
    "eu-west-2"      = "ew2"
    "eu-west-3"      = "ew3"
    "af-south-1"     = "fs1"
    "me-south-1"     = "ms1"
    "sa-east-1"      = "se1"
    "us-east-1"      = "ue1"
    "us-east-2"      = "ue2"
    "us-west-1"      = "uw1"
    "us-west-2"      = "uw2"
  }

  name_string = "${local.aws_regions_short[var.aws_region]}-${var.environment}-${var.project_name}"

  # What a repository gets when `ecr_repo_settings` does not name it: the project-wide defaults,
  # which are the template's own and which every repository built before #1811 already has.
  ecr_repo_defaults = {
    immutable_tags         = var.ecr_repository_image_tag_mutability == "IMMUTABLE"
    vulnerability_scanning = var.ecr_repository_image_scan_on_push
  }

  # One entry per repository: the base name, plus the two switches resolved against those defaults.
  #
  # `merge` and not a per-attribute `try(var.ecr_repo_settings[k].immutable_tags, …)`, deliberately.
  # The offer-parity carrier probe counts a read of `.immutable_tags` anywhere in a `locals`, `module`
  # or `resource` block on this chain, so resolving attribute-by-attribute HERE would satisfy the
  # probe from this file — and ecr.tf could then hardcode the argument and still measure as carried.
  # Written this way, the one and only `.immutable_tags` read on the chain is the one in ecr.tf that
  # actually reaches the repository, so hardcoding it is caught. (Checked: `output` blocks are not
  # scanned, which is why outputs.tf may spell the attribute freely.)
  #
  # An entry present in the map always carries BOTH attributes — the object type's `optional(bool,
  # true)` fills whichever the caller omitted — so naming a repository at all opts it out of the
  # project-wide defaults for both switches.
  ecr_input = var.ecr_create_repository && length(var.ecr_names_map) > 0 ? {
    for k, base in var.ecr_names_map : k => merge(
      local.ecr_repo_defaults,
      { repo_base = base },
      try(var.ecr_repo_settings[k], {}),
    )
  } : {}

  # Default ECR lifecycle policy. Two rules, in the order AWS evaluates them:
  #   1. untagged images expire 14 days after push — build churn and orphaned layers,
  #      which are pure storage cost and never pulled by a running workload.
  #   2. keep only the newest 30 tagged images per repository — enough to roll back
  #      several releases deep without retaining every tag ever pushed.
  # A rulePriority must be unique and ascending; the `any` tagStatus rule has to sort
  # last, because AWS requires the catch-all to be the highest priority in the document.
  default_lifecycle_policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images 14 days after push"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep only the 30 most recent images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 30
        }
        action = { type = "expire" }
      },
    ]
  })

  # coalesce() would treat "" as present; this must fall back on an EMPTY string too,
  # since "" is exactly what the upstream module defaults to and what AWS rejects.
  lifecycle_policy = (
    var.ecr_repository_lifecycle_policy == null || var.ecr_repository_lifecycle_policy == ""
    ? local.default_lifecycle_policy
    : var.ecr_repository_lifecycle_policy
  )
}
