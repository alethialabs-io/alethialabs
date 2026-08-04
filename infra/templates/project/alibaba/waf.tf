# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# The WAF 3.0 instance takes NO inputs — see modules/waf/main.tf for the schema evidence and
# for why the domain binding is not expressible in the pinned provider. The `domain` and `tags`
# arguments that used to be passed here reached module variables no resource could ever read;
# `var.alidns_domain` is still carried by dns.tf, which is the only place it lands.
module "waf" {
  source = "./modules/waf"
  count  = var.application_waf_enabled ? 1 : 0
}
