locals {
  gcp_regions_short = {
    "us-central1"             = "uc1"
    "us-east1"                = "ue1"
    "us-east4"                = "ue4"
    "us-east5"                = "ue5"
    "us-south1"               = "us1"
    "us-west1"                = "uw1"
    "us-west2"                = "uw2"
    "us-west3"                = "uw3"
    "us-west4"                = "uw4"
    "northamerica-northeast1" = "nn1"
    "northamerica-northeast2" = "nn2"
    "southamerica-east1"      = "se1"
    "southamerica-west1"      = "sw1"
    "europe-west1"            = "ew1"
    "europe-west2"            = "ew2"
    "europe-west3"            = "ew3"
    "europe-west4"            = "ew4"
    "europe-west6"            = "ew6"
    "europe-west8"            = "ew8"
    "europe-west9"            = "ew9"
    "europe-west10"           = "e10"
    "europe-west12"           = "e12"
    "europe-north1"           = "en1"
    "europe-central2"         = "ec2"
    "europe-southwest1"       = "es1"
    "asia-east1"              = "ae1"
    "asia-east2"              = "ae2"
    "asia-northeast1"         = "an1"
    "asia-northeast2"         = "an2"
    "asia-northeast3"         = "an3"
    "asia-south1"             = "as1"
    "asia-south2"             = "as2"
    "asia-southeast1"         = "at1"
    "asia-southeast2"         = "at2"
    "australia-southeast1"    = "au1"
    "australia-southeast2"    = "au2"
    "me-west1"                = "mw1"
    "me-central1"             = "mc1"
    "africa-south1"           = "af1"
  }

  gcp_default_labels = {
    "environment" = var.environment
    "service"     = var.project_name
    "managed-by"  = "opentofu"
  }

  # Naming conventions
  vpc_name = "vpc-${local.gcp_regions_short[var.region]}-${var.environment}-${var.project_name}"
  gke_name = "gke-${local.gcp_regions_short[var.region]}-${var.environment}-${var.project_name}"

  cloud_sql_name        = "sql-${local.gcp_regions_short[var.region]}-${var.environment}-${var.project_name}"
  memorystore_name      = "redis-${local.gcp_regions_short[var.region]}-${var.environment}-${var.project_name}"
  cloud_dns_name        = "dns-${local.gcp_regions_short[var.region]}-${var.environment}-${var.project_name}"
  cloud_armor_name      = "armor-${local.gcp_regions_short[var.region]}-${var.environment}-${var.project_name}"
  secret_manager_prefix = "${local.gcp_regions_short[var.region]}-${var.environment}-${var.project_name}"
}
