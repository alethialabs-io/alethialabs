# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "aws_region" {
  description = "AWS region the SES identities live in (matches ALETHIA_SES_REGION)."
  type        = string
  default     = "eu-central-1"
}

variable "domain" {
  description = "Root domain. Sending subdomains hang off this."
  type        = string
  default     = "alethialabs.io"
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

variable "events_webhook_url" {
  # Apply this only once the console /api/webhooks/ses route is live — SNS posts a
  # SubscriptionConfirmation the endpoint must confirm. Set "" for a first apply
  # before the app is deployed.
  description = "Public HTTPS endpoint SNS posts bounce/complaint events to (the deployed console)."
  type        = string
  default     = "https://alethialabs.io/api/webhooks/ses"
}

variable "alarm_email" {
  description = "Inbox subscribed to the SES reputation CloudWatch alarms. Empty → no email subscription."
  type        = string
  default     = "borislav@alethialabs.io"
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
