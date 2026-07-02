# Brownfield networking: when `provision_vnet = false`, attach AKS to a subnet of an EXISTING VNet
# instead of creating one. The console sends `vnet_id` (the VNet's full ARM resource id); we parse its
# resource group + name from the id, data-source the VNet, pick a subnet, and resolve that subnet's id
# for AKS. Fixes the prior bug where the VNet id was passed straight to AKS as a subnet id. Greenfield
# (provision_vnet = true) is untouched: these data sources have count = 0 and the `module.vnet` seam is
# used as before.
#
# NOTE: verify against a real AKS + existing VNet. Assumption: use the VNet's first subnet.
# ARM id shape: /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworks/<name>

locals {
  existing_vnet_parts = var.provision_vnet ? [] : split("/", var.vnet_id)
  existing_vnet_rg    = var.provision_vnet ? "" : element(local.existing_vnet_parts, 4)
  existing_vnet_name  = var.provision_vnet ? "" : element(local.existing_vnet_parts, 8)
}

data "azurerm_virtual_network" "existing" {
  count               = var.provision_vnet ? 0 : 1
  name                = local.existing_vnet_name
  resource_group_name = local.existing_vnet_rg
}

locals {
  existing_subnet_name = var.provision_vnet ? "" : try(data.azurerm_virtual_network.existing[0].subnets[0], "")
}

data "azurerm_subnet" "existing" {
  count                = var.provision_vnet ? 0 : 1
  name                 = local.existing_subnet_name
  virtual_network_name = local.existing_vnet_name
  resource_group_name  = local.existing_vnet_rg
}
