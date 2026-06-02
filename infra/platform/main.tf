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

# Default provider (eu-west-1 for ECR + scaler)
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

locals {
  name_prefix = "${var.project_name}-${var.environment}"
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

# ---------- Dynamic tendril deployments ----------

module "tendril" {
  source   = "./worker"
  for_each = var.tendrils

  region             = each.value.region
  name_prefix        = "${local.name_prefix}-${each.key}"
  image              = var.image
  tendril_version    = var.tendril_version
  trellis_url        = each.value.trellis_url
  trellis_api_secret = var.trellis_api_secret
  worker_mode        = var.worker_mode

  infracost_api_key           = var.infracost_api_key
  supabase_s3_endpoint        = var.supabase_s3_endpoint
  supabase_s3_region          = var.supabase_s3_region
  supabase_storage_key_id     = var.supabase_storage_key_id
  supabase_storage_secret_key = var.supabase_storage_secret_key

  secrets_recovery_window_days = var.secrets_recovery_window_days
}

# ---------- Lambda scaler (eu-west-1) ----------

module "scaler" {
  source = "./scaler"

  name_prefix               = local.name_prefix
  supabase_url              = var.supabase_url
  supabase_service_role_key = var.supabase_service_role_key

  workers = [
    for name, w in module.tendril : {
      region  = var.tendrils[name].region
      cluster = w.cluster_name
      service = w.service_name
    }
  ]
}
