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

  # Platform base tags. Classification + sweep-handle tags (var.classification_tags) are merged in
  # UNDER these — base tags sit on the merge RHS so they always WIN a key collision, keeping the
  # sweep handles and platform bookkeeping authoritative. This local is applied to every taggable
  # Azure resource (AKS, the DB, Key Vault, Service Bus, Redis, ACR, Storage, Cosmos, ...).
  azure_base_tags = {
    "Environment" = title(var.environment)
    "Service"     = var.project_name
    "ManagedBy"   = "opentofu"
  }

  azure_default_tags = merge(var.classification_tags, local.azure_base_tags)

  # Naming conventions
  location_short = local.azure_locations_short[var.location]

  vnet_name            = "vnet-${local.location_short}-${var.environment}-${var.project_name}"
  aks_name             = "aks-${local.location_short}-${var.environment}-${var.project_name}"
  azure_db_name        = "db-${local.location_short}-${var.environment}-${var.project_name}"
  azure_cache_name     = "redis-${local.location_short}-${var.environment}-${var.project_name}"
  azure_dns_name       = "dns-${local.location_short}-${var.environment}-${var.project_name}"
  azure_waf_name       = "waf-${local.location_short}-${var.environment}-${var.project_name}"
  app_gateway_name     = "agw-${local.location_short}-${var.environment}-${var.project_name}"
  key_vault_name       = "kv-${local.location_short}-${var.environment}-${var.project_name}"
  acr_name             = "acr${local.location_short}${var.environment}${var.project_name}"
  service_bus_name     = "sb-${local.location_short}-${var.environment}-${var.project_name}"
  cosmos_db_name       = "cosmos-${local.location_short}-${var.environment}-${var.project_name}"
  storage_account_name = "st${local.location_short}${var.environment}${var.project_name}"

  # The external-secrets managed identity this deploy uses: the caller's adopted one, or the one we
  # created. Everything that federates, grants to, or exports the ESO identity reads these — never
  # the resource directly — so adoption cannot be honoured in one place and missed in another. A
  # half-adopted deploy would grant Key Vault access to the created identity while the target
  # subscription trusts the adopted one, and ESO would authenticate as a principal with no read grant.
  #
  # Adoption requires BOTH inputs (the data source is keyed on name + resource group, not a resource
  # id); a check block rejects supplying only one rather than silently falling back to create.
  external_secrets_adopted = var.provision_aks && var.external_secrets_identity_name != "" && var.external_secrets_identity_resource_group != ""
  external_secrets_identity_id = var.provision_aks ? (
    local.external_secrets_adopted
    ? data.azurerm_user_assigned_identity.external_secrets_adopted[0].id
    : azurerm_user_assigned_identity.external_secrets[0].id
  ) : ""
  external_secrets_client_id = var.provision_aks ? (
    local.external_secrets_adopted
    ? data.azurerm_user_assigned_identity.external_secrets_adopted[0].client_id
    : azurerm_user_assigned_identity.external_secrets[0].client_id
  ) : ""
  external_secrets_principal_id = var.provision_aks ? (
    local.external_secrets_adopted
    ? data.azurerm_user_assigned_identity.external_secrets_adopted[0].principal_id
    : azurerm_user_assigned_identity.external_secrets[0].principal_id
  ) : ""

  # ── Application Gateway / AGIC (see application-gateway.tf) ────────────────────────────────
  #
  # An Application Gateway is a STANDING cost — a v2 gateway bills per hour from the moment it
  # exists, whether or not a single Ingress object was ever created — so it is not implied by
  # merely having a cluster the way the (free) AWS Load Balancer Controller is. The default
  # (`azure_application_gateway_enabled = null`) is instead "follow the WAF switch": on Azure an
  # azurerm_web_application_firewall_policy binds to an Application Gateway and to NOTHING else,
  # so a project that turned the canvas WAF on and got no gateway is carrying a policy, a bill,
  # and zero inspected requests — the exact defect this lane closes. Setting the variable
  # explicitly overrides in both directions: `true` buys the ingress without a WAF, `false`
  # keeps the pre-lane shape.
  request_application_gateway = var.azure_application_gateway_enabled != null ? var.azure_application_gateway_enabled : var.azure_waf_enabled

  # A gateway needs a subnet of its own, and only the VNet this template creates can carve one
  # (modules/vnet azurerm_subnet.application_gateway) — a brownfield VNet is the caller's and we
  # will not go carving subnets in it. So `provision_vnet` is a hard term. An EXPLICIT request on a
  # brownfield network is refused at plan (checks_ingress.tf) rather than silently dropped; the
  # IMPLIED one (WAF on, brownfield) degrades to today's behaviour and says so.
  enable_application_gateway = local.request_application_gateway && var.provision_vnet

  # The WAF_v2 SKU and firewall_policy_id are driven from this ONE term so they cannot diverge:
  # a Standard_v2 gateway rejects a firewall policy association outright, and a WAF_v2 gateway
  # with no policy is a more expensive gateway that filters nothing.
  app_gateway_waf_attached = local.enable_application_gateway && var.azure_waf_enabled

  # AGIC is the in-cluster half: no cluster, no controller (and no OIDC issuer to federate its
  # identity to). The gateway itself is still built — it is useful, and billed, either way.
  enable_agic = local.enable_application_gateway && var.provision_aks
}
