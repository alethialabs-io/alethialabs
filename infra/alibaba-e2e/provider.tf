# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# RAM is a GLOBAL service; `region` only selects the provider endpoint + STS. The maintainer
# authenticates natively (ALICLOUD_ACCESS_KEY / ALICLOUD_SECRET_KEY, or an `aliyun` CLI profile,
# or a RAM session) with an admin identity — this stack is a one-time IAM bootstrap (invariant 4:
# `tofu apply` on infra/ IAM stacks is maintainer-only; agents never apply). No credential is ever
# stored in state.
provider "alicloud" {
  region = var.region
}
