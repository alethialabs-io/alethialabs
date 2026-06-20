terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }

  backend "s3" {}
}

# ---------- Providers ----------

provider "aws" {
  region = "eu-west-1"
  default_tags {
    tags = {
      Project     = var.project_name
      Environment = title(var.environment)
      Service     = "Runner"
      ManagedBy   = "opentofu"
    }
  }
}

provider "aws" {
  alias  = "eu_central_1"
  region = "eu-central-1"
  default_tags {
    tags = {
      Project     = var.project_name
      Environment = title(var.environment)
      Service     = "Runner"
      ManagedBy   = "opentofu"
    }
  }
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"

  shared_runner_vars = {
    image                        = var.image
    runner_version               = var.runner_version
    alethia_api_secret           = var.alethia_api_secret
    runner_mode                  = var.runner_mode
    infracost_api_key            = var.infracost_api_key
    storage_endpoint             = var.storage_endpoint
    storage_region               = var.storage_region
    storage_access_key_id        = var.storage_access_key_id
    storage_secret_access_key    = var.storage_secret_access_key
    secrets_recovery_window_days = var.secrets_recovery_window_days
  }

  all_runners = [
    for name, cfg in var.runners : {
      key         = name
      region      = cfg.region
      name_prefix = "${local.name_prefix}-${name}"
      alethia_url = cfg.alethia_url
    }
  ]
}

# ---------- ECR (eu-west-1 only) ----------

resource "aws_ecr_repository" "runner" {
  name                 = "${local.name_prefix}-runner"
  image_tag_mutability = var.ecr_image_tag_mutability
  force_delete         = var.ecr_force_delete

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "runner" {
  repository = aws_ecr_repository.runner.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = { type = "expire" }
      }
    ]
  })
}

# ---------- Runner deployments (eu-west-1) ----------

module "runner_eu_west_1" {
  source   = "./runner"
  for_each = { for t in local.all_runners : t.key => t if t.region == "eu-west-1" }

  region             = each.value.region
  name_prefix        = each.value.name_prefix
  alethia_url        = each.value.alethia_url
  image              = local.shared_runner_vars.image
  runner_version     = local.shared_runner_vars.runner_version
  alethia_api_secret = local.shared_runner_vars.alethia_api_secret
  runner_mode        = local.shared_runner_vars.runner_mode

  infracost_api_key         = local.shared_runner_vars.infracost_api_key
  storage_endpoint          = local.shared_runner_vars.storage_endpoint
  storage_region            = local.shared_runner_vars.storage_region
  storage_access_key_id     = local.shared_runner_vars.storage_access_key_id
  storage_secret_access_key = local.shared_runner_vars.storage_secret_access_key

  secrets_recovery_window_days = local.shared_runner_vars.secrets_recovery_window_days
}

# ---------- Runner deployments (eu-central-1) ----------

module "runner_eu_central_1" {
  source   = "./runner"
  for_each = { for t in local.all_runners : t.key => t if t.region == "eu-central-1" }

  providers = {
    aws = aws.eu_central_1
  }

  region             = each.value.region
  name_prefix        = each.value.name_prefix
  alethia_url        = each.value.alethia_url
  image              = local.shared_runner_vars.image
  runner_version     = local.shared_runner_vars.runner_version
  alethia_api_secret = local.shared_runner_vars.alethia_api_secret
  runner_mode        = local.shared_runner_vars.runner_mode

  infracost_api_key         = local.shared_runner_vars.infracost_api_key
  storage_endpoint          = local.shared_runner_vars.storage_endpoint
  storage_region            = local.shared_runner_vars.storage_region
  storage_access_key_id     = local.shared_runner_vars.storage_access_key_id
  storage_secret_access_key = local.shared_runner_vars.storage_secret_access_key

  secrets_recovery_window_days = local.shared_runner_vars.secrets_recovery_window_days
}

# ---------- Lambda scaler (eu-west-1) ----------

locals {
  all_runner_modules = merge(module.runner_eu_west_1, module.runner_eu_central_1)
}

module "scaler" {
  source = "./scaler"

  name_prefix        = local.name_prefix
  alethia_api_secret = var.alethia_api_secret

  runners = [
    for name, w in local.all_runner_modules : {
      region      = var.runners[name].region
      cluster     = w.cluster_name
      service     = w.service_name
      alethia_url = var.runners[name].alethia_url
    }
  ]
}
