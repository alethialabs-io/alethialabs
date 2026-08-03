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

# Per-repository switches, keyed like ecr_names_map. Optional in both directions: the map may omit a
# repository, and an entry may omit either attribute. Whatever is missing falls back to the two
# project-wide defaults below — see local.ecr_input, which does the resolving once.
variable "ecr_repo_settings" {
  type = map(object({
    immutable_tags         = optional(bool, true)
    vulnerability_scanning = optional(bool, true)
  }))
  default     = {}
  description = "Per-repository tag-immutability and vulnerability-scanning settings, keyed like ecr_names_map."
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

# The policy DOCUMENT. Upstream terraform-aws-modules/ecr/aws v2.4.0 defaults
# `repository_lifecycle_policy` to "" and still creates the resource whenever
# `create_lifecycle_policy` is true — so leaving this unset produced an empty
# lifecyclePolicyText and AWS rejected the apply outright:
#
#   InvalidParameterException: Invalid parameter at 'lifecyclePolicyText' failed
#   to satisfy constraint: 'Member must have length greater than or equal to 100'
#
# Null means "use locals.default_lifecycle_policy" rather than "no policy": a
# registry with no expiry rule grows without bound, and the top-level default for
# ecr_create_lifecycle_policy is true, so every tenant that provisions a native
# ECR gets a real policy instead of a failed apply.
variable "ecr_repository_lifecycle_policy" {
  description = "ECR lifecycle policy document (JSON). Null ⇒ the module's default: expire untagged after 14 days, keep the last 30 tagged images."
  type        = string
  default     = null
}

variable "resources_tags" {
  type    = map(string)
  default = {}
}