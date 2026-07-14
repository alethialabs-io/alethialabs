# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Alethia near-real-time asset-inventory event forwarder (Alibaba Cloud). ActionTrail publishes VPC /
# VSwitch create+delete API events to the EventBridge default bus; a rule routes them to a Function
# Compute forwarder that normalizes each change to Alethia's NormalizedCloudEvent contract and POSTs it
# to the console ingester (/api/cloud-events/alibaba). Opt-in companion to the RAM connector (main.tf);
# only normalized {kind, native_id, region, deleted} events leave the account — never credentials.
#
# NOTE: deploy/verify in a real Alibaba account (ActionTrail + EventBridge + Function Compute must be
# enabled). The console ingester + the normalized contract are live; this is the in-account forwarder
# half. `terraform apply` this file alongside main.tf (same `region` provider).

variable "ingestion_url" {
  type        = string
  description = "Base URL of the Alethia console, e.g. https://app.alethialabs.io"
}

variable "ingestion_secret" {
  type        = string
  sensitive   = true
  description = "Shared bearer secret the forwarder presents (matches the console's ALETHIA_CRON_SECRET)."
}

data "alicloud_account" "current" {}

# ── Function Compute forwarder ───────────────────────────────────────────────
# The forwarder source (normalizes an ActionTrail event → POST). Packaged from ./forwarder.
data "archive_file" "forwarder" {
  type        = "zip"
  source_dir  = "${path.module}/forwarder"
  output_path = "${path.module}/.build/forwarder-alibaba.zip"
}

# Execution role Function Compute assumes to run the forwarder (logs only; no cloud API access needed).
resource "alicloud_ram_role" "forwarder" {
  role_name   = "AlethiaAssetForwarder"
  description = "Execution role for the Alethia asset-change Function Compute forwarder."
  assume_role_policy_document = jsonencode({
    Version = "1"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = ["fc.aliyuncs.com"] }
    }]
  })
}

resource "alicloud_ram_role_policy_attachment" "forwarder_logs" {
  role_name   = alicloud_ram_role.forwarder.id
  policy_name = "AliyunLogFullAccess"
  policy_type = "System"
}

resource "alicloud_fc_service" "forwarder" {
  name        = "alethia-asset-forwarder"
  description = "Alethia asset-change forwarder."
  role        = alicloud_ram_role.forwarder.arn
}

resource "alicloud_fc_function" "forwarder" {
  service     = alicloud_fc_service.forwarder.name
  name        = "forward"
  description = "Normalizes an ActionTrail VPC/VSwitch change and POSTs it to the Alethia ingester."
  runtime     = "nodejs18"
  handler     = "index.handler"
  filename    = data.archive_file.forwarder.output_path
  memory_size = 256
  timeout     = 30

  environment_variables = {
    INGESTION_URL      = var.ingestion_url
    INGESTION_SECRET   = var.ingestion_secret
    ALIBABA_ACCOUNT_ID = data.alicloud_account.current.id
  }
}

# ── EventBridge routing (ActionTrail → Function Compute) ─────────────────────
# ActionTrail delivers cloud-service API events to the EventBridge "default" bus. The rule matches VPC /
# VSwitch create+delete events and targets the forwarder function. EventBridge needs a service-linked
# role to invoke FC (AliyunServiceRoleForEventBridgeSendToFC), created on first use in the console.
resource "alicloud_event_bridge_rule" "asset_changes" {
  event_bus_name = "default"
  rule_name      = "alethia-asset-changes"
  description    = "Route VPC/VSwitch create+delete ActionTrail events to the Alethia forwarder."
  filter_pattern = jsonencode({
    source = ["acs.vpc"]
    type = [
      { prefix = "vpc:CreateVpc" },
      { prefix = "vpc:DeleteVpc" },
      { prefix = "vpc:CreateVSwitch" },
      { prefix = "vpc:DeleteVSwitch" },
    ]
  })
  status = "ENABLE"

  targets {
    target_id = "alethia-forwarder"
    endpoint  = alicloud_fc_function.forwarder.function_arn
    type      = "acs.fc.function"

    param_list {
      resource_key = "serviceName"
      form         = "CONSTANT"
      value        = alicloud_fc_service.forwarder.name
    }
    param_list {
      resource_key = "functionName"
      form         = "CONSTANT"
      value        = alicloud_fc_function.forwarder.name
    }
    param_list {
      resource_key = "Body"
      form         = "ORIGINAL"
    }
  }
}
