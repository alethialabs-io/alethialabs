module "ecr" {
  source  = "terraform-aws-modules/ecr/aws"
  version = "2.4.0"

  for_each = local.ecr_input

  # Use ecr_enabled directly
  create_repository = var.ecr_create_repository

  # Compose repo name; optional project prefix
  repository_name = var.ecr_prefix_with_projectname ? format("%s-%s", var.project_name, each.value.repo_base) : each.value.repo_base


  repository_type                   = var.ecr_repository_type
  repository_read_write_access_arns = var.ecr_repository_read_write_access_arns
  repository_read_access_arns       = var.ecr_repository_read_access_arns
  repository_encryption_type        = var.ecr_repository_encryption_type
  # PER REPOSITORY, not registry-wide — both are attributes of `aws_ecr_repository`, and the canvas
  # offers both per registry component. `local.ecr_input` has already resolved each against the
  # project-wide default, so two components with opposite answers stay opposite.
  repository_image_scan_on_push          = each.value.vulnerability_scanning
  repository_image_tag_mutability        = each.value.immutable_tags ? "IMMUTABLE" : "MUTABLE"
  manage_registry_scanning_configuration = var.ecr_manage_registry_scanning_configuration
  registry_scan_type                     = var.ecr_registry_scan_type
  registry_scan_rules                    = var.ecr_registry_scan_rules
  create_lifecycle_policy                = var.ecr_create_lifecycle_policy
  # MUST accompany create_lifecycle_policy. Upstream creates aws_ecr_lifecycle_policy with
  # whatever this holds — its own default is "" — and AWS rejects a policy document shorter
  # than 100 characters, so an unset value FAILS the apply rather than skipping the policy.
  repository_lifecycle_policy = local.lifecycle_policy

  tags = merge(
    var.resources_tags,
    {
      "component" = "ecr"
      "env"       = var.environment
      "name"      = local.name_string
      "repo-base" = each.value.repo_base
    }
  )
}

