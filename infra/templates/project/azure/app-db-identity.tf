#########################################################################
##     Keyless app→Postgres identity (Entra Workload Identity)  #722    ##
#########################################################################
# When the Flexible Server has Entra (AAD) authentication enabled, the app workload connects to it
# KEYLESSLY: a user-assigned managed identity is federated (via AKS Workload Identity) to the app KSA,
# so the app authenticates with a short-lived Entra access token (scope ossrdbms-aad.database.windows.net)
# minted from its own identity — no password. The app pod runs the token-refresher + pgbouncer
# sidecars (see the manifest keyless lane + Lane D); this mirrors the external-dns / external-secrets
# federated-identity pattern.
#
# LEAST-PRIVILEGE (#722 R5): the app identity is NOT the server's Entra administrator. A SEPARATE
# `db_admin` managed identity is registered as the sole Entra administrator; it is federated only to
# the one-shot bootstrap Job's KSA (default/alethia-db-bootstrap). That Job (an ArgoCD PreSync hook)
# logs in as the admin, creates a SCOPED Postgres role for the app (bound to the app UAMI's object id
# via a pgaadauth SECURITY LABEL, granted only CONNECT + schema USAGE/CREATE), and exits. The app
# UAMI (`app_db`) therefore only ever logs in as that scoped role — never as a superuser/admin.
#
# The federated subjects (namespace/name of each KSA) MUST match `manifests`:
#   app_db   → keylessKSANamespace/keylessKSAName          (the app pod)
#   db_admin → keylessKSANamespace/keylessBootstrapKSAName (the bootstrap Job pod)

locals {
  # Coupling point with packages/core/manifests (keylessKSAName / keylessBootstrapKSAName /
  # keylessKSANamespace).
  azure_app_ksa_namespace  = "default"
  azure_app_ksa_name       = "alethia-app"
  azure_bootstrap_ksa_name = "alethia-db-bootstrap"
  # Postgres only (the AAD/Entra path); MySQL Flexible Server AAD is a separate follow-up.
  enable_app_db_aad = var.create_azure_db && var.azure_db_iam_auth && var.provision_aks && var.azure_db_engine == "postgres"
}

########################################################################
# App identity — the pod's login identity, federated to the app KSA.   #
# Scoped (NOT admin): the bootstrap Job binds it to a least-priv role. #
########################################################################

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

########################################################################
# Dedicated DB-admin identity — the ONLY Entra administrator. Federated #
# solely to the bootstrap Job's KSA, so no app pod can assume it.       #
########################################################################

resource "azurerm_user_assigned_identity" "db_admin" {
  count               = local.enable_app_db_aad ? 1 : 0
  name                = "${local.aks_name}-dbadmin"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
}

resource "azurerm_federated_identity_credential" "db_admin" {
  count               = local.enable_app_db_aad ? 1 : 0
  name                = "db-admin"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = azurerm_user_assigned_identity.db_admin[0].id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = module.aks[0].oidc_issuer_url
  subject             = "system:serviceaccount:${local.azure_app_ksa_namespace}:${local.azure_bootstrap_ksa_name}"
}

# Register the DEDICATED admin identity (not the app) as the server's Entra administrator, so the
# bootstrap Job can create the app's scoped role. The app identity holds no admin rights.
resource "azurerm_postgresql_flexible_server_active_directory_administrator" "db_admin" {
  count               = local.enable_app_db_aad ? 1 : 0
  server_name         = module.azure_db[0].server_name
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  object_id           = azurerm_user_assigned_identity.db_admin[0].principal_id
  principal_name      = azurerm_user_assigned_identity.db_admin[0].name
  principal_type      = "ServicePrincipal"
}
