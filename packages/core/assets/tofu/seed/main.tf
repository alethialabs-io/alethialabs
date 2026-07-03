terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Environment = title(var.environment)
      Service     = var.project_name
      ManagedBy   = "opentofu"
    }
  }
}


locals {
  name = "${var.project_name}-${var.environment}"
  tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "Alethia"
  }

  create_vpc = var.vpc_id == ""
}

# 1. VPC (Only created if vpc_id is empty)
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"
  count   = local.create_vpc ? 1 : 0

  name = "${local.name}-vpc"
  cidr = var.vpc_cidr

  azs                     = ["${var.region}a", "${var.region}b"]
  private_subnets         = [cidrsubnet(var.vpc_cidr, 8, 1), cidrsubnet(var.vpc_cidr, 8, 2)]
  public_subnets          = [cidrsubnet(var.vpc_cidr, 8, 101), cidrsubnet(var.vpc_cidr, 8, 102)]
  map_public_ip_on_launch = true

  enable_nat_gateway = true
  single_nat_gateway = true

  tags = local.tags
}

# Data source for existing VPC subnets if vpc_id is provided
data "aws_subnets" "existing" {
  count = local.create_vpc ? 0 : 1
  filter {
    name   = "vpc-id"
    values = [var.vpc_id]
  }
}

locals {
  # Select subnets: either the new private ones, or the existing ones found
  subnet_ids = local.create_vpc ? module.vpc[0].private_subnets : data.aws_subnets.existing[0].ids
}

# 2. EKS Cluster
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = "${local.name}-cluster"
  cluster_version = var.cluster_version

  vpc_id     = local.create_vpc ? module.vpc[0].vpc_id : var.vpc_id
  subnet_ids = local.subnet_ids

  cluster_endpoint_public_access = true

  enable_cluster_creator_admin_permissions = true

  eks_managed_node_groups = {
    default = {
      min_size     = 1
      max_size     = 2
      desired_size = 1

      instance_types = var.instance_types
      capacity_type  = "SPOT"

      # Explicitly set subnets for the node group
      subnet_ids = local.subnet_ids

      # Fix for "Ec2SubnetInvalidConfiguration": Force disable public IPs
      # This ensures nodes can launch in private subnets (standard) 
      # or public subnets without auto-assign-public-ip enabled.
      network_interfaces = [
        {
          associate_public_ip_address = false
          delete_on_termination       = true
        }
      ]
    }
  }

  enable_irsa = true
  tags        = local.tags
}

# 3. Runner Agent IAM Role (IRSA)
module "runner_role" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.0"

  role_name = "${local.name}-runner-role"

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["runner-system:runner"]
    }
  }

  # For the prototype, we grant AdministratorAccess so Runner can provision any resource
  # In production, this should be scoped down to the specific resources managed by Alethia
  role_policy_arns = {
    admin = "arn:aws:iam::aws:policy/AdministratorAccess"
  }

  tags = local.tags
}

output "runner_role_arn" {
  value = module.runner_role.iam_role_arn
}

output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "cluster_certificate_authority_data" {
  value = module.eks.cluster_certificate_authority_data
}

output "cluster_name" {
  value = module.eks.cluster_name
}