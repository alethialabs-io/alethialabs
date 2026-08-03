################################################################################
# Locals
################################################################################

locals {
  name_prefix = "${var.project_name}-${var.environment}"

  # Derive two /20 subnets from the VNet CIDR
  # Private: first /20 block, Public: second /20 block
  vnet_prefix_length = tonumber(split("/", var.vnet_cidr)[1])
  vnet_base          = split("/", var.vnet_cidr)[0]

  private_subnet_cidr = cidrsubnet(var.vnet_cidr, 20 - local.vnet_prefix_length, 0)
  public_subnet_cidr  = cidrsubnet(var.vnet_cidr, 20 - local.vnet_prefix_length, 1)
  # Third, dedicated subnet for the PostgreSQL Flexible Server delegation (see azurerm_subnet.database).
  database_subnet_cidr = cidrsubnet(var.vnet_cidr, 20 - local.vnet_prefix_length, 2)
  # Fourth, dedicated subnet for an Application Gateway v2 (see azurerm_subnet.application_gateway).
  application_gateway_subnet_cidr = cidrsubnet(var.vnet_cidr, 20 - local.vnet_prefix_length, 3)

  common_tags = merge(var.labels, {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "opentofu"
  })
}

################################################################################
# Virtual Network
################################################################################

resource "azurerm_virtual_network" "this" {
  name                = "${local.name_prefix}-vnet"
  location            = var.location
  resource_group_name = var.resource_group_name
  address_space       = [var.vnet_cidr]

  tags = local.common_tags
}

################################################################################
# Subnets
################################################################################

resource "azurerm_subnet" "private" {
  name                 = "${local.name_prefix}-private"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [local.private_subnet_cidr]

  service_endpoints = [
    "Microsoft.Sql",
    "Microsoft.Storage",
    "Microsoft.KeyVault",
  ]
}

resource "azurerm_subnet" "public" {
  name                 = "${local.name_prefix}-public"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [local.public_subnet_cidr]
}

# Azure Database for PostgreSQL Flexible Server with VNet integration REQUIRES its own subnet,
# DELEGATED to Microsoft.DBforPostgreSQL/flexibleServers. Pointing it at the shared private subnet
# (which also hosts the AKS nodes) fails the create:
#   "The subnet name as <x>-private is missing required delegations
#    Microsoft.DBforPostgreSQL/flexibleServers"
# and a delegated subnet cannot host anything else — so it must be a THIRD, dedicated subnet.
# Without this the DATABASE KIND was impossible to create. (Found on a real max-config apply.)
resource "azurerm_subnet" "database" {
  name                 = "${local.name_prefix}-db"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [local.database_subnet_cidr]

  delegation {
    name = "postgres-flexible-server"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

# An Application Gateway v2 also needs a subnet of its own: Azure places the gateway's instances
# into it and refuses to deploy into a subnet holding anything else
# ("ApplicationGatewaySubnetCannotHaveOtherResources"), and it may not be shared with the AKS nodes.
# That makes a FOURTH derived block the only way this module can express one — the same shape as the
# delegated database subnet above, for a different reason (dedication, not delegation).
#
# Carved UNCONDITIONALLY rather than behind the gateway's own toggle. A subnet costs nothing, index 3
# was previously unused so the private/public/database prefixes do not move and no existing subnet is
# replaced, and turning the gateway on later is then a one-resource add instead of a VNet change on a
# live cluster. NO network security group is associated: an Application Gateway v2 requires inbound
# 65200-65535 from the GatewayManager service tag to stay reachable by the control plane, and an NSG
# that forgets that rule takes the gateway to an unhealthy state — the subnet default (no NSG) is the
# safe shape here, and the gateway's own listeners are what terminate public traffic.
resource "azurerm_subnet" "application_gateway" {
  name                 = "${local.name_prefix}-appgw"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [local.application_gateway_subnet_cidr]
}

################################################################################
# NAT Gateway
################################################################################

resource "azurerm_public_ip" "nat" {
  count = var.single_nat_gateway ? 1 : 0

  name                = "${local.name_prefix}-nat-pip"
  location            = var.location
  resource_group_name = var.resource_group_name
  allocation_method   = "Static"
  sku                 = "Standard"

  tags = local.common_tags
}

resource "azurerm_nat_gateway" "this" {
  count = var.single_nat_gateway ? 1 : 0

  name                    = "${local.name_prefix}-nat-gw"
  location                = var.location
  resource_group_name     = var.resource_group_name
  sku_name                = "Standard"
  idle_timeout_in_minutes = 10

  tags = local.common_tags
}

resource "azurerm_nat_gateway_public_ip_association" "this" {
  count = var.single_nat_gateway ? 1 : 0

  nat_gateway_id       = azurerm_nat_gateway.this[0].id
  public_ip_address_id = azurerm_public_ip.nat[0].id
}

resource "azurerm_subnet_nat_gateway_association" "private" {
  count = var.single_nat_gateway ? 1 : 0

  subnet_id      = azurerm_subnet.private.id
  nat_gateway_id = azurerm_nat_gateway.this[0].id
}

################################################################################
# Network Security Group — Private Subnet
################################################################################

resource "azurerm_network_security_group" "private" {
  name                = "${local.name_prefix}-private-nsg"
  location            = var.location
  resource_group_name = var.resource_group_name

  # Allow inbound from VNet
  security_rule {
    name                       = "AllowVNetInbound"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "VirtualNetwork"
  }

  # Deny all other inbound from internet
  security_rule {
    name                       = "DenyInternetInbound"
    priority                   = 4096
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "Internet"
    destination_address_prefix = "*"
  }

  tags = local.common_tags
}

resource "azurerm_subnet_network_security_group_association" "private" {
  subnet_id                 = azurerm_subnet.private.id
  network_security_group_id = azurerm_network_security_group.private.id
}
