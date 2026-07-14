# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# AWS Budgets + Cost Explorer are a GLOBAL service homed in us-east-1, and Budgets can
# only publish to an SNS topic that lives in us-east-1. This aliased provider pins the
# e2e cost-guard (budget + SNS + topic policy) to us-east-1 regardless of the region the
# rest of the stack (or the e2e provisioning) runs in. IAM is global, so the roles/policies
# use the default provider.
provider "aws" {
  alias  = "useast1"
  region = "us-east-1"
}
