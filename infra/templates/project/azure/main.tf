terraform {
  required_version = "~> 1.1"
  backend "http" {}

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 3.0, < 5.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = ">= 2.0, < 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

provider "azuread" {}

provider "kubernetes" {
  host                   = var.provision_aks ? module.aks[0].cluster_endpoint : ""
  client_certificate     = var.provision_aks ? base64decode(module.aks[0].client_certificate) : ""
  client_key             = var.provision_aks ? base64decode(module.aks[0].client_key) : ""
  cluster_ca_certificate = var.provision_aks ? base64decode(module.aks[0].cluster_ca_certificate) : ""
}

provider "helm" {
  kubernetes {
    host                   = var.provision_aks ? module.aks[0].cluster_endpoint : ""
    client_certificate     = var.provision_aks ? base64decode(module.aks[0].client_certificate) : ""
    client_key             = var.provision_aks ? base64decode(module.aks[0].client_key) : ""
    cluster_ca_certificate = var.provision_aks ? base64decode(module.aks[0].cluster_ca_certificate) : ""
  }
}

data "azurerm_client_config" "current" {}

resource "azurerm_resource_group" "main" {
  # Derived in checks_naming.tf (NAMING-002), not composed here: `rg-<project_name>-<environment>`
  # carried no budget against Azure's 90-character cap, and this is the one name whose overflow
  # fails the whole deploy rather than a single offer.
  name     = local.azure_resource_group_name
  location = var.location

  tags = local.azure_default_tags
}
