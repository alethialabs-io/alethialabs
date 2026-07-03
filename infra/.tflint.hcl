# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Shared tflint config for every stack + template under infra/ (referenced via
# TFLINT_CONFIG_FILE in .github/actions/iac-checks). Covers all three clouds so the same
# config lints aws / gcp / azure stacks.

config {
  call_module_type = "local"
  force            = false
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.36.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}

plugin "google" {
  enabled = true
  version = "0.32.0"
  source  = "github.com/terraform-linters/tflint-ruleset-google"
}

plugin "azurerm" {
  enabled = true
  version = "0.28.0"
  source  = "github.com/terraform-linters/tflint-ruleset-azurerm"
}
