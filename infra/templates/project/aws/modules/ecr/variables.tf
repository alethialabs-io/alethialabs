################################################################################
# Provider
################################################################################

variable "aws_region" {
  type        = string
  description = "AWS region to deploy to"
}

################################################################################
# Utility variables
################################################################################

variable "environment" {
  type        = string
  description = "Environment in which resources are deployed"
}

variable "project_name" {
  type        = string
  description = "Name of the project / client / product to be used in naming convention"
}

################################################################################
# Repository
################################################################################

variable "ecr_create_repository" {
  type        = bool
  default     = false
  description = "Master switch for creating ECR repositories"
}

variable "ecr_names_map" {
  type        = map(string)
  default     = {}
  description = "Map of repositories to create. Example: { r1 = \"myfirstrepo\", r2 = \"mysecondrepo\" }"
}

variable "ecr_prefix_with_projectname" {
  type        = bool
  default     = true
  description = "If true, prefix repository names with the project name (project-<repo>)"
}

/* passthroughs to the ecr module */
variable "ecr_repository_type" {
  type    = string
  default = null
}

variable "ecr_repository_read_write_access_arns" {
  type    = list(string)
  default = []
}

variable "ecr_repository_read_access_arns" {
  type    = list(string)
  default = []
}

variable "ecr_repository_encryption_type" {
  type    = string
  default = null
}

variable "ecr_repository_image_scan_on_push" {
  type    = bool
  default = true
}

variable "ecr_repository_image_tag_mutability" {
  type    = string
  default = "IMMUTABLE"
}

variable "ecr_manage_registry_scanning_configuration" {
  type    = bool
  default = false
}

variable "ecr_registry_scan_type" {
  type    = string
  default = null
}

variable "ecr_registry_scan_rules" {
  type    = any
  default = null
}

variable "ecr_create_lifecycle_policy" {
  type    = bool
  default = false
}

variable "resources_tags" {
  type    = map(string)
  default = {}
}