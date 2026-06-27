# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "aws_region" {
  description = "AWS region the SES identities live in (matches ALETHIA_SES_REGION)."
  type        = string
  default     = "eu-central-1"
}

variable "domain" {
  description = "Root domain. Sending subdomains and _dmarc hang off this."
  type        = string
  default     = "alethialabs.io"
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token with DNS edit on the zone."
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for var.domain."
  type        = string
}

# Reputation-isolated sending streams. Each gets its own SES domain identity,
# DKIM, custom MAIL FROM (bounce.<subdomain>), and configuration set, so a
# reputation hit on one stream never poisons another. Keys must match the app's
# stream names (auth, general) — see packages/email/src/config.ts.
variable "streams" {
  description = "Sending streams → subdomain (relative to var.domain)."
  type = map(object({
    subdomain = string
  }))
  default = {
    auth    = { subdomain = "auth" } # auth.<domain> — AUTH_EMAIL_FROM
    general = { subdomain = "mail" } # mail.<domain> — EMAIL_FROM
  }
}

variable "dmarc_rua" {
  description = "DMARC aggregate-report mailbox (rua=). Must be a real inbox."
  type        = string
  default     = "mailto:dmarc@alethialabs.io"
}

variable "dmarc_policy" {
  description = "DMARC policy. Start at none; tighten to quarantine/reject once reports are clean."
  type        = string
  default     = "none"
  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "dmarc_policy must be none, quarantine, or reject."
  }
}

variable "events_webhook_url" {
  description = "Public HTTPS endpoint SNS posts bounce/complaint events to (the deployed console). Empty → no HTTPS subscription is created (apply it once the app handler is live)."
  type        = string
  default     = ""
}

variable "alarm_email" {
  description = "Ops inbox subscribed to the SES reputation CloudWatch alarms. Empty → no email subscription."
  type        = string
  default     = ""
}

variable "bounce_rate_threshold" {
  description = "Account bounce-rate alarm threshold (fraction). AWS pauses sending at 0.10."
  type        = number
  default     = 0.05
}

variable "complaint_rate_threshold" {
  description = "Account complaint-rate alarm threshold (fraction). AWS pauses sending at 0.005."
  type        = number
  default     = 0.001
}
