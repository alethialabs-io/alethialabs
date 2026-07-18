#########################################################################
##     Keyless app→Postgres identity (Entra Workload Identity)  #722    ##
#########################################################################
# When the Flexible Server has Entra (AAD) authentication enabled, the app workload connects to it
# KEYLESSLY: a user-assigned managed identity is federated (via AKS Workload Identity) to the app KSA
# and registered as the server's Entra administrator, so the app authenticates with a short-lived
# Entra access token (scope ossrdbms-aad.database.windows.net) minted from its own identity — no
# password. The app pod runs the token-refresher + pgbouncer sidecars (see the manifest keyless lane
# + Lane D); this mirrors the external-dns / external-secrets federated-identity pattern.
#
# The federated subject (namespace/name of the app KSA) MUST match `manifests`
# keylessKSANamespace/keylessKSAName.
#
# NOTE (least-privilege follow-up): registering the app identity as the AAD ADMINISTRATOR is
# functional but broad (admin ≈ DB superuser). A scoped per-app Postgres role — created by a
# bootstrap Job the admin runs, not tofu (SQL role creation needs DB connectivity, not the ARM API)
# — is the least-privilege target and is tracked as a keyless follow-up. Gated behind the
# azure_db_iam_auth flag + the real-cloud e2e + alethia-security-review.

locals {
  # Coupling point with packages/core/manifests (keylessKSAName / keylessKSANamespace).
  azure_app_ksa_namespace = "default"
  azure_app_ksa_name      = "alethia-app"
  # Postgres only (the AAD/Entra path); MySQL Flexible Server AAD is a separate follow-up.
  enable_app_db_aad = var.create_azure_db && var.azure_db_iam_auth && var.provision_aks && var.azure_db_engine == "postgres"
}

resource "azurerm_user_assigned_identity" "app_db" {
  count               = local.enable_app_db_aad ? 1 : 0
  name                = "${local.aks_name}-appdb"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
}

resource "azurerm_federated_identity_credential" "app_db" {
  count               = local.enable_app_db_aad ? 1 : 0
  name                = "app-db"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = azurerm_user_assigned_identity.app_db[0].id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = module.aks[0].oidc_issuer_url
  subject             = "system:serviceaccount:${local.azure_app_ksa_namespace}:${local.azure_app_ksa_name}"
}

# Register the app identity as the server's Entra administrator so it can log in via a token.
resource "azurerm_postgresql_flexible_server_active_directory_administrator" "app_db" {
  count               = local.enable_app_db_aad ? 1 : 0
  server_name         = module.azure_db[0].server_name
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  object_id           = azurerm_user_assigned_identity.app_db[0].principal_id
  principal_name      = azurerm_user_assigned_identity.app_db[0].name
  principal_type      = "ServicePrincipal"
}
