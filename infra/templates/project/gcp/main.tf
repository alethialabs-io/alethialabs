terraform {
  required_version = "~> 1.1"
  backend "http" {}

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0, < 7.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 5.0, < 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = local.gcp_region_key
}

provider "google-beta" {
  project = var.project_id
  region  = local.gcp_region_key
}

provider "kubernetes" {
  host                   = "https://${module.gke[0].cluster_endpoint}"
  token                  = data.google_client_config.default.access_token
  cluster_ca_certificate = base64decode(module.gke[0].cluster_ca_certificate)
}

provider "helm" {
  kubernetes {
    host                   = "https://${module.gke[0].cluster_endpoint}"
    token                  = data.google_client_config.default.access_token
    cluster_ca_certificate = base64decode(module.gke[0].cluster_ca_certificate)
  }
}

data "google_client_config" "default" {}
data "google_project" "current" {}
