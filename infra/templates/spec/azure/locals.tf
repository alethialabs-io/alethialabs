locals {
  azure_locations_short = {
    "eastus"             = "eus"
    "eastus2"            = "eu2"
    "westus"             = "wus"
    "westus2"            = "wu2"
    "westus3"            = "wu3"
    "centralus"          = "cus"
    "northcentralus"     = "ncu"
    "southcentralus"     = "scu"
    "westcentralus"      = "wcu"
    "canadacentral"      = "cac"
    "canadaeast"         = "cae"
    "brazilsouth"        = "brs"
    "westeurope"         = "weu"
    "northeurope"        = "neu"
    "uksouth"            = "uks"
    "ukwest"             = "ukw"
    "francecentral"      = "frc"
    "francesouth"        = "frs"
    "germanywestcentral" = "gwc"
    "switzerlandnorth"   = "szn"
    "norwayeast"         = "noe"
    "swedencentral"      = "sec"
    "polandcentral"      = "plc"
    "italynorth"         = "itn"
    "eastasia"           = "eas"
    "southeastasia"      = "sea"
    "japaneast"          = "jpe"
    "japanwest"          = "jpw"
    "koreacentral"       = "krc"
    "koreasouth"         = "krs"
    "centralindia"       = "cin"
    "southindia"         = "sin"
    "westindia"          = "win"
    "australiaeast"      = "aue"
    "australiasoutheast" = "aus"
    "southafricanorth"   = "san"
    "uaenorth"           = "uan"
    "qatarcentral"       = "qtc"
  }

  azure_default_tags = {
    "Environment" = title(var.environment)
    "Service"     = var.project_name
    "ManagedBy"   = "opentofu"
  }

  # Naming conventions
  location_short = local.azure_locations_short[var.location]

  vnet_name            = "vnet-${local.location_short}-${var.environment}-${var.project_name}"
  aks_name             = "aks-${local.location_short}-${var.environment}-${var.project_name}"
  azure_db_name        = "db-${local.location_short}-${var.environment}-${var.project_name}"
  azure_cache_name     = "redis-${local.location_short}-${var.environment}-${var.project_name}"
  azure_dns_name       = "dns-${local.location_short}-${var.environment}-${var.project_name}"
  azure_waf_name       = "waf-${local.location_short}-${var.environment}-${var.project_name}"
  key_vault_name       = "kv-${local.location_short}-${var.environment}-${var.project_name}"
  acr_name             = "acr${local.location_short}${var.environment}${var.project_name}"
  service_bus_name     = "sb-${local.location_short}-${var.environment}-${var.project_name}"
  cosmos_db_name       = "cosmos-${local.location_short}-${var.environment}-${var.project_name}"
  storage_account_name = "st${local.location_short}${var.environment}${var.project_name}"
}
