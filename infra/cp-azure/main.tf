# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# alethialabs.io control plane on Azure — a single x86 Gen2 Linux VM running the same self-host
# bundle (app · docs · postgres · s3 · runner) behind Caddy, fronted by a Cloudflare Tunnel.
# Ported from infra/cp-hetzner but shaped for Azure: the box has NO public web ingress (the NSG
# has NO inbound Allow rules — Azure denies inbound by default), and there is NO open SSH. Admin /
# deploy is via `az vm run-command` (control-plane, through the VM agent — no port) with the VM's
# managed identity; interactive break-glass is via Azure Serial Console (boot diagnostics). The
# Standard public IP is egress-only (image pulls, git clone, dialing the tunnel out); Azure retires
# default outbound (Sep 2025), so an explicit egress IP is required and is cheapest for one box (a
# NAT gateway would be ~10x). The OS disk holds Postgres + object storage.

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

# Egress-only public IP. Inbound is denied by the NSG below; this exists so the box can reach the
# internet (and so Azure's default-outbound retirement doesn't strand it).
resource "azurerm_public_ip" "cp" {
  name                = "alethia-cp"
  location            = azurerm_resource_group.cp.location
  resource_group_name = azurerm_resource_group.cp.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

# NSG with NO inbound Allow rules — web is Cloudflare-Tunnel-fronted and admin is `az vm run-command`
# (control-plane, no port). Azure NSGs deny inbound by default, so the absence of Allow rules IS the
# closed posture; egress uses the default allow-outbound rules.
resource "azurerm_network_security_group" "cp" {
  name                = "alethia-cp"
  location            = azurerm_resource_group.cp.location
  resource_group_name = azurerm_resource_group.cp.name
  tags                = local.tags
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
  name                            = "alethia-cp"
  resource_group_name             = azurerm_resource_group.cp.name
  location                        = azurerm_resource_group.cp.location
  size                            = var.vm_size
  admin_username                  = var.admin_username
  network_interface_ids           = [azurerm_network_interface.cp.id]
  disable_password_authentication = true
  tags                            = local.tags

  # Trusted Launch (Gen2) — secure boot + vTPM, Azure's Shielded-VM analog.
  secure_boot_enabled = true
  vtpm_enabled        = true

  # System-assigned identity so `az vm run-command` / the box authenticate with no static creds.
  identity {
    type = "SystemAssigned"
  }

  # Enables the Azure Serial Console (break-glass) via a managed boot-diagnostics storage account.
  boot_diagnostics {}

  # Kept for Serial-Console use; never network-reachable (no inbound SSH).
  admin_ssh_key {
    username   = var.admin_username
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = var.os_disk_size
  }

  # Ubuntu 24.04 LTS, x86 Gen2 (Trusted-Launch capable; matches the linux/amd64 self-host images).
  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    repo_url = var.repo_url
  }))
}

# ── Cloudflare Tunnel ──────────────────────────────────────────────────────────
# The origin is never exposed: cloudflared (a compose service on the box) dials OUT to Cloudflare
# and forwards the tunnel's ingress to Caddy over the internal network. TLS terminates at
# Cloudflare's edge. config_src = "cloudflare" = remotely-managed config, so the connector only
# needs the token (see the tunnel_token output → TUNNEL_TOKEN env).
resource "random_id" "tunnel_secret" {
  byte_length = 35
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "cp" {
  account_id = var.cloudflare_account_id
  name       = "alethia-cp-azure"
  secret     = random_id.tunnel_secret.b64_std
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "cp" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.cp.id

  config {
    # Apex + www forward to Caddy, which stitches console + marketing + docs + blog into the one
    # origin.
    ingress_rule {
      hostname = var.domain
      service  = "http://caddy:80"
    }
    ingress_rule {
      hostname = "www.${var.domain}"
      service  = "http://caddy:80"
    }
    # Required catch-all.
    ingress_rule {
      service = "http_status:404"
    }
  }
}

# DNS — proxied CNAMEs onto the tunnel (Cloudflare flattens the apex CNAME). Proxied is mandatory
# for cfargotunnel.com targets; ttl must be 1 (auto) when proxied.
resource "cloudflare_record" "apex" {
  zone_id = var.cloudflare_zone_id
  name    = "@"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.cp.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

resource "cloudflare_record" "www" {
  zone_id = var.cloudflare_zone_id
  name    = "www"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.cp.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}
