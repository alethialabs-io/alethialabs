# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "domain_name" {
  type = string
}

# Extra names on the SAME certificate. Each one adds its own DNS validation option, which is why
# the validation records are a for_each over domain_validation_options rather than a single [0].
variable "subject_alternative_names" {
  type        = list(string)
  default     = []
  description = "Additional names to place on the certificate alongside domain_name. Each gets its own Route 53 validation record."
}

variable "r53_zone_id" {
  default     = ""
  description = "Route53 zone. If domain name is specified and a cert needs to be created"
}
