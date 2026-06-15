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
      Service     = "Tendril"
      ManagedBy   = "terraform"
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
      Service     = "Tendril"
      ManagedBy   = "terraform"
    }
  }
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"

  shared_worker_vars = {
    image                       = var.image
    node_version             = var.node_version
    alethia_api_secret          = var.alethia_api_secret
    worker_mode                 = var.worker_mode
    infracost_api_key           = var.infracost_api_key
    supabase_s3_endpoint        = var.supabase_s3_endpoint
    supabase_s3_region          = var.supabase_s3_region
    supabase_storage_key_id     = var.supabase_storage_key_id
    supabase_storage_secret_key = var.supabase_storage_secret_key
    secrets_recovery_window_days = var.secrets_recovery_window_days
  }

  all_nodes = [
    for name, cfg in var.nodes : {
      key         = name
      region      = cfg.region
      name_prefix = "${local.name_prefix}-${name}"
      alethia_url = cfg.alethia_url
    }
  ]
}

# ---------- ECR (eu-west-1 only) ----------

resource "aws_ecr_repository" "tendril" {
  name                 = "${local.name_prefix}-tendril"
  image_tag_mutability = var.ecr_image_tag_mutability
  force_delete         = var.ecr_force_delete

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "tendril" {
  repository = aws_ecr_repository.tendril.name

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

# ---------- Tendril deployments (eu-west-1) ----------

module "tendril_eu_west_1" {
  source   = "./worker"
  for_each = { for t in local.all_nodes : t.key => t if t.region == "eu-west-1" }

  region             = each.value.region
  name_prefix        = each.value.name_prefix
  alethia_url        = each.value.alethia_url
  image              = local.shared_worker_vars.image
  node_version    = local.shared_worker_vars.node_version
  alethia_api_secret = local.shared_worker_vars.alethia_api_secret
  worker_mode        = local.shared_worker_vars.worker_mode

  infracost_api_key           = local.shared_worker_vars.infracost_api_key
  supabase_s3_endpoint        = local.shared_worker_vars.supabase_s3_endpoint
  supabase_s3_region          = local.shared_worker_vars.supabase_s3_region
  supabase_storage_key_id     = local.shared_worker_vars.supabase_storage_key_id
  supabase_storage_secret_key = local.shared_worker_vars.supabase_storage_secret_key

  secrets_recovery_window_days = local.shared_worker_vars.secrets_recovery_window_days
}

# ---------- Tendril deployments (eu-central-1) ----------

module "tendril_eu_central_1" {
  source   = "./worker"
  for_each = { for t in local.all_nodes : t.key => t if t.region == "eu-central-1" }

  providers = {
    aws = aws.eu_central_1
  }

  region             = each.value.region
  name_prefix        = each.value.name_prefix
  alethia_url        = each.value.alethia_url
  image              = local.shared_worker_vars.image
  node_version    = local.shared_worker_vars.node_version
  alethia_api_secret = local.shared_worker_vars.alethia_api_secret
  worker_mode        = local.shared_worker_vars.worker_mode

  infracost_api_key           = local.shared_worker_vars.infracost_api_key
  supabase_s3_endpoint        = local.shared_worker_vars.supabase_s3_endpoint
  supabase_s3_region          = local.shared_worker_vars.supabase_s3_region
  supabase_storage_key_id     = local.shared_worker_vars.supabase_storage_key_id
  supabase_storage_secret_key = local.shared_worker_vars.supabase_storage_secret_key

  secrets_recovery_window_days = local.shared_worker_vars.secrets_recovery_window_days
}

# ---------- Lambda scaler (eu-west-1) ----------

locals {
  all_worker_modules = merge(module.tendril_eu_west_1, module.tendril_eu_central_1)
}

module "scaler" {
  source = "./scaler"

  name_prefix               = local.name_prefix
  supabase_url              = var.supabase_url
  supabase_service_role_key = var.supabase_service_role_key

  workers = [
    for name, w in local.all_worker_modules : {
      region  = var.nodes[name].region
      cluster = w.cluster_name
      service = w.service_name
    }
  ]
}
