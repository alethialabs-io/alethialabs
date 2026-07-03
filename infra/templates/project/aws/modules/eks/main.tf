terraform {
  required_version = ">= 1.3"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.34"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.11"
    }
    helm = {
      source  = "hashicorp/helm"
      version = ">= 2.8"
    }
    kubectl = {
      source  = "gavinbunney/kubectl"
      version = ">= 1.7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3"
    }
  }
}
