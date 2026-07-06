# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# alethialabs.io control plane on Azure — a single Ampere ARM (Dpsv5) Linux VM
# running the same self-host bundle as the other hosts. Host-agnostic; the
# deploy-app workflow SSHes here identically.

locals {
  tags = {
    project = "alethia"
    role    = "control-plane"
    managed = "opentofu"
  }
}

resource "azurerm_resource_group" "cp" {
  name     = var.resource_group_name
  location = var.location
  tags     = local.tags
}

resource "azurerm_virtual_network" "cp" {
  name                = "alethia-cp"
  location            = azurerm_resource_group.cp.location
  resource_group_name = azurerm_resource_group.cp.name
  address_space       = ["10.20.0.0/16"]
  tags                = local.tags
}

resource "azurerm_subnet" "cp" {
  name                 = "default"
  resource_group_name  = azurerm_resource_group.cp.name
  virtual_network_name = azurerm_virtual_network.cp.name
  address_prefixes     = ["10.20.1.0/24"]
}

resource "azurerm_public_ip" "cp" {
  name                = "alethia-cp"
  location            = azurerm_resource_group.cp.location
  resource_group_name = azurerm_resource_group.cp.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

resource "azurerm_network_security_group" "cp" {
  name                = "alethia-cp"
  location            = azurerm_resource_group.cp.location
  resource_group_name = azurerm_resource_group.cp.name
  tags                = local.tags

  security_rule {
    name                       = "ssh"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefixes    = var.ssh_allowed_cidrs
    destination_address_prefix = "*"
  }
  security_rule {
    name                       = "web"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_ranges    = ["80", "443"]
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_network_interface" "cp" {
  name                = "alethia-cp"
  location            = azurerm_resource_group.cp.location
  resource_group_name = azurerm_resource_group.cp.name
  tags                = local.tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.cp.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.cp.id
  }
}

resource "azurerm_network_interface_security_group_association" "cp" {
  network_interface_id      = azurerm_network_interface.cp.id
  network_security_group_id = azurerm_network_security_group.cp.id
}

resource "azurerm_linux_virtual_machine" "cp" {
  name                  = "alethia-cp"
  resource_group_name   = azurerm_resource_group.cp.name
  location              = azurerm_resource_group.cp.location
  size                  = var.vm_size
  admin_username        = var.admin_username
  network_interface_ids = [azurerm_network_interface.cp.id]
  tags                  = local.tags

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = var.os_disk_size
  }

  # Ubuntu 24.04 LTS, ARM64.
  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server-arm64"
    version   = "latest"
  }

  # Shared cloud-init (the Hetzner-volume step no-ops; Docker uses the OS disk).
  custom_data = base64encode(templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    repo_url = var.repo_url
  }))
}

# DNS — unproxied so Caddy's ACME challenge reaches the box directly.
resource "cloudflare_record" "apex_a" {
  zone_id = var.cloudflare_zone_id
  name    = "@"
  type    = "A"
  content = azurerm_public_ip.cp.ip_address
  proxied = false
  ttl     = 300
}

resource "cloudflare_record" "www_a" {
  zone_id = var.cloudflare_zone_id
  name    = "www"
  type    = "A"
  content = azurerm_public_ip.cp.ip_address
  proxied = false
  ttl     = 300
}
