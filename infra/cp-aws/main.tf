# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# alethialabs.io control plane on AWS — a single Graviton EC2 box running the
# same self-host bundle as the Hetzner target (host-agnostic; the deploy-app
# workflow SSHes here exactly the same way). Cheapest single-box AWS shape;
# free on a lab account with credits.

locals {
  tags = {
    project = "alethia"
    role    = "control-plane"
    managed = "terraform"
  }
}

data "aws_vpc" "default" {
  default = true
}

# Latest Ubuntu 24.04 (noble) ARM64, Canonical.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_key_pair" "deploy" {
  key_name   = "alethia-deploy"
  public_key = var.ssh_public_key
}

resource "aws_security_group" "cp" {
  name        = "alethia-cp"
  description = "Alethia control plane: SSH + HTTP/HTTPS"
  vpc_id      = data.aws_vpc.default.id
  tags        = local.tags

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_allowed_cidrs
  }
  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "cp" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  key_name                    = aws_key_pair.deploy.key_name
  vpc_security_group_ids      = [aws_security_group.cp.id]
  associate_public_ip_address = true
  tags                        = merge(local.tags, { Name = "alethia-cp" })

  root_block_device {
    volume_size = var.root_volume_size
    volume_type = "gp3"
    encrypted   = true
  }

  # Shared cloud-init (the Hetzner-volume mount step no-ops on AWS; Docker uses
  # the root EBS, which is durable + snapshottable).
  user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    repo_url = var.repo_url
  })
}

resource "aws_eip" "cp" {
  instance = aws_instance.cp.id
  domain   = "vpc"
  tags     = local.tags
}

# DNS — unproxied so Caddy's ACME challenge reaches the box directly.
resource "cloudflare_record" "apex_a" {
  zone_id = var.cloudflare_zone_id
  name    = "@"
  type    = "A"
  content = aws_eip.cp.public_ip
  proxied = false
  ttl     = 300
}

resource "cloudflare_record" "www_a" {
  zone_id = var.cloudflare_zone_id
  name    = "www"
  type    = "A"
  content = aws_eip.cp.public_ip
  proxied = false
  ttl     = 300
}
