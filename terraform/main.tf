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

# ---------- Aliased providers (one per region) ----------

provider "aws" {
  alias  = "eu_west_1"
  region = "eu-west-1"

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
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
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"
}

# ---------- ECR (eu-west-1 only) ----------

resource "aws_ecr_repository" "tendril" {
  provider             = aws.eu_west_1
  name                 = "${local.name_prefix}-tendril"
  image_tag_mutability = var.ecr_image_tag_mutability
  force_delete         = var.ecr_force_delete

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "tendril" {
  provider   = aws.eu_west_1
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

# ---------- Worker: eu-west-1 ----------

module "worker_eu_west_1" {
  source    = "./worker"
  providers = { aws = aws.eu_west_1 }

  region          = "eu-west-1"
  name_prefix     = local.name_prefix
  worker_id       = var.eu_west_1_worker_id
  worker_token    = var.eu_west_1_worker_token
  image           = var.image
  tendril_version = var.tendril_version
  vpc_id          = var.eu_west_1_vpc_id
  subnet_ids      = var.eu_west_1_subnet_ids
  trellis_url     = var.trellis_url
  worker_mode     = var.worker_mode

  infracost_api_key           = var.infracost_api_key
  supabase_s3_endpoint        = var.supabase_s3_endpoint
  supabase_s3_region          = var.supabase_s3_region
  supabase_storage_key_id     = var.supabase_storage_key_id
  supabase_storage_secret_key = var.supabase_storage_secret_key

  secrets_recovery_window_days = var.secrets_recovery_window_days
  assign_public_ip             = var.assign_public_ip
}

# ---------- Worker: eu-central-1 ----------

module "worker_eu_central_1" {
  source    = "./worker"
  providers = { aws = aws.eu_central_1 }

  region          = "eu-central-1"
  name_prefix     = local.name_prefix
  worker_id       = var.eu_central_1_worker_id
  worker_token    = var.eu_central_1_worker_token
  image           = var.image
  tendril_version = var.tendril_version
  vpc_id          = var.eu_central_1_vpc_id
  subnet_ids      = var.eu_central_1_subnet_ids
  trellis_url     = var.trellis_url
  worker_mode     = var.worker_mode

  infracost_api_key           = var.infracost_api_key
  supabase_s3_endpoint        = var.supabase_s3_endpoint
  supabase_s3_region          = var.supabase_s3_region
  supabase_storage_key_id     = var.supabase_storage_key_id
  supabase_storage_secret_key = var.supabase_storage_secret_key

  secrets_recovery_window_days = var.secrets_recovery_window_days
  assign_public_ip             = var.assign_public_ip
}

# ---------- Scaler (Lambda in eu-west-1) ----------

module "scaler" {
  source    = "./scaler"
  providers = { aws = aws.eu_west_1 }

  name_prefix               = local.name_prefix
  supabase_url              = var.supabase_url
  supabase_service_role_key = var.supabase_service_role_key

  workers = [
    {
      region  = "eu-west-1"
      cluster = module.worker_eu_west_1.cluster_name
      service = module.worker_eu_west_1.service_name
    },
    {
      region  = "eu-central-1"
      cluster = module.worker_eu_central_1.cluster_name
      service = module.worker_eu_central_1.service_name
    },
  ]
}
