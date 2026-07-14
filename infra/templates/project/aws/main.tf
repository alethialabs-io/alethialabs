terraform {
  required_version = "~> 1.1"
  backend "http" {}



  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.81, < 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

# default_tags fans the classification + sweep-handle tags out to EVERY taggable AWS resource
# (including ones not passed local.aws_default_tags, e.g. S3/DynamoDB/Route53/WAF), so a guarded
# sweeper can scope destroys to one environment. The three platform base tags sit on the merge RHS
# and WIN any key collision. Base keys are unnamespaced; classification keys are `alethia:`-scoped,
# so in practice they never collide — the RHS ordering is the belt-and-suspenders guarantee.
provider "aws" {
  region = var.region
  default_tags {
    tags = merge(var.classification_tags, {
      Environment = title(var.environment)
      Service     = var.project_name
      ManagedBy   = "opentofu"
    })
  }
}

# needed for WAF module
provider "aws" {
  alias  = "virginia"
  region = "us-east-1"
  default_tags {
    tags = merge(var.classification_tags, {
      Environment = title(var.environment)
      Service     = var.project_name
      ManagedBy   = "opentofu"
    })
  }
}

# The kubernetes/helm providers are declared for completeness but define no resources
# (ArgoCD + add-ons are installed post-apply by the runner via kubectl/helm). The former
# `exec { command = "aws" eks get-token }` auth block was removed as part of the CLI-free
# runner: no aws CLI is present in the image. If in-template k8s/helm resources are ever
# added, authenticate with `data.aws_eks_cluster_auth` (a token, no CLI) rather than exec.
provider "kubernetes" {
  host                   = module.eks[0].eks_cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks[0].eks_cluster_certificate_authority_data)
}

provider "helm" {
  kubernetes {
    host                   = module.eks[0].eks_cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks[0].eks_cluster_certificate_authority_data)
  }
}

data "aws_caller_identity" "current" {}
