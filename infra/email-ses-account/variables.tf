# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Every input whose default would be a DECISION has no default here: it is either committed in
# terraform.tfvars (public values) or supplied from the gitignored emails.auto.tfvars. The same rule
# as infra/aws-e2e, for the same reasons (scripts/check-tfvars-safety.mjs states them).

# ── Accounts ───────────────────────────────────────────────────────────────────────────────────────

variable "email_account_id" {
  description = "The dedicated `alethia-email` member account every resource here lands in. The provider refuses any other (allowed_account_ids)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.email_account_id))
    error_message = "email_account_id must be a 12-digit AWS account id."
  }
}

variable "alethia_account_id" {
  description = "The Alethia platform account (prod state bucket, prod vault). Named so a precondition can refuse email_account_id == this: SES in that account was denied production access, and the point of this stack is a separate account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.alethia_account_id))
    error_message = "alethia_account_id must be a 12-digit AWS account id."
  }
}

variable "email_admin_role_name" {
  description = "The role in the email account the provider assumes. Created by infra/email-ses-account/bootstrap (its admin_role_name)."
  type        = string
  default     = "alethia-email-admin"
}

variable "email_region" {
  description = "The region SES production access was granted in. The app's ALETHIA_SES_REGION must equal it: SES identities, configuration sets and sending quotas are per region."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.email_region))
    error_message = "email_region must be an AWS region name such as eu-central-1."
  }
}

# ── Sending ──────────────────────────────────────────────────────────────────────────────────────

variable "domain" {
  description = "The SES domain identity that already exists, verified, in the email account. Read, never created: see identity.tf."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+(\\.[a-z0-9-]+)+$", var.domain))
    error_message = "domain must be a bare lower-case domain name such as alethialabs.io."
  }
}

variable "events_webhook_url" {
  description = <<-EOT
    The console's SES event webhook that SNS posts configuration-set events to. null creates no
    HTTPS subscription (the topic and the config sets still exist). It must be https, and the
    console behind it must already accept this account's events topic ARN
    (ALETHIA_SES_EVENTS_TOPIC_ARNS), because SNS confirms the subscription by calling it and the
    apply waits for that confirmation.
  EOT
  type        = string
  nullable    = true

  validation {
    condition     = var.events_webhook_url == null || can(regex("^https://[^/]+/api/webhooks/ses$", var.events_webhook_url))
    error_message = "events_webhook_url must be null or an https URL ending in /api/webhooks/ses (the console route)."
  }
}

variable "sender_user_name" {
  description = "The IAM user whose access key the app sends with. Its access key is minted OUTSIDE this stack (README step 5), so no secret ever reaches the state."
  type        = string
  default     = "alethia-ses-sender"
}

variable "sender_source_cidrs" {
  description = <<-EOT
    Optional aws:SourceIp lock on the sender's send permission: the CIDRs the app's SES calls leave
    from. [] adds no IP condition. A non-empty list means a send from anywhere else is refused, so a
    re-provisioned box with a new address stops sending mail until this is updated. Required and
    committed (terraform.tfvars) so the choice is visible.
  EOT
  type        = list(string)

  validation {
    condition = alltrue([
      for c in var.sender_source_cidrs : can(cidrhost(c, 0)) && !endswith(c, "/0")
    ])
    error_message = "sender_source_cidrs entries must be valid CIDRs, and none may be a /0 (that is no lock at all)."
  }
}

# ── Reputation alarms ────────────────────────────────────────────────────────────────────────────

variable "ses_alarm_emails" {
  description = "Inboxes subscribed to the reputation alarms topic. REQUIRED with no default (personal addresses, public repo): set it in the gitignored emails.auto.tfvars. [] is the explicit opt-out."
  type        = list(string)

  validation {
    condition     = alltrue([for e in var.ses_alarm_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "ses_alarm_emails must be a list of email addresses."
  }
}

variable "bounce_rate_threshold" {
  description = "Account bounce-rate alarm threshold (fraction). AWS reviews the account at 0.05 and may pause sending at 0.10. Same value as infra/email-ses."
  type        = number
  default     = 0.05

  validation {
    condition     = var.bounce_rate_threshold > 0 && var.bounce_rate_threshold < 0.10
    error_message = "bounce_rate_threshold must be above 0 and below 0.10, where AWS may already have paused sending."
  }
}

variable "complaint_rate_threshold" {
  description = "Account complaint-rate alarm threshold (fraction). AWS reviews the account at 0.001 and may pause sending at 0.005. Same value as infra/email-ses."
  type        = number
  default     = 0.001

  validation {
    condition     = var.complaint_rate_threshold > 0 && var.complaint_rate_threshold < 0.005
    error_message = "complaint_rate_threshold must be above 0 and below 0.005, where AWS may already have paused sending."
  }
}
