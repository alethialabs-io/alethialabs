#########################################################################
##            Workload Identity for cluster add-ons                    ##
#########################################################################
# Creates a user-assigned managed identity for external-dns and federates it to
# the AKS OIDC issuer + the in-cluster external-dns KSA, so external-dns manages
# Azure DNS with NO static secret. The identity's client id is exported as
# `external_dns_client_id` and rendered onto the external-dns ServiceAccount by
# the ArgoCD Application (azure.workload.identity/client-id annotation). This is
# the Azure analogue of the AWS IRSA role the EKS path uses.

resource "azurerm_user_assigned_identity" "external_dns" {
  count               = var.provision_aks ? 1 : 0
  name                = "${local.aks_name}-extdns"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
}

resource "azurerm_federated_identity_credential" "external_dns" {
  count               = var.provision_aks ? 1 : 0
  name                = "external-dns"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = azurerm_user_assigned_identity.external_dns[0].id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = module.aks[0].oidc_issuer_url
  subject             = "system:serviceaccount:external-dns:external-dns-sa"
}

# DNS Zone Contributor over the resource group so external-dns can manage records.
resource "azurerm_role_assignment" "external_dns_dns" {
  count                = var.provision_aks ? 1 : 0
  scope                = azurerm_resource_group.main.id
  role_definition_name = "DNS Zone Contributor"
  principal_id         = azurerm_user_assigned_identity.external_dns[0].principal_id
}
