module "ecr" {
  source  = "terraform-aws-modules/ecr/aws"
  version = "2.4.0"

  for_each = local.ecr_input

  # Use ecr_enabled directly
  create_repository = var.ecr_create_repository

  # Compose repo name; optional project prefix
  repository_name = var.ecr_prefix_with_projectname ? format("%s-%s", var.project_name, each.value) : each.value


  repository_type                         = var.ecr_repository_type
  repository_read_write_access_arns       = var.ecr_repository_read_write_access_arns
  repository_read_access_arns             = var.ecr_repository_read_access_arns
  repository_encryption_type              = var.ecr_repository_encryption_type
  repository_image_scan_on_push           = var.ecr_repository_image_scan_on_push
  repository_image_tag_mutability         = var.ecr_repository_image_tag_mutability
  manage_registry_scanning_configuration  = var.ecr_manage_registry_scanning_configuration
  registry_scan_type                      = var.ecr_registry_scan_type
  registry_scan_rules                     = var.ecr_registry_scan_rules
  create_lifecycle_policy                 = var.ecr_create_lifecycle_policy

  tags = merge(
    var.resources_tags,
    {
      "component"  = "ecr"
      "env"        = var.environment
      "name"       = local.name_string
      "repo-base"  = each.value
    }
  )
}

