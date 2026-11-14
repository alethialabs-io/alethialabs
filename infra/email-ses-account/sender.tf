# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The identity the app sends as: one IAM user whose only permission is to send as the domain
# identity, through it and the two configuration sets. Why a user with a static key and not a role
# is in README.md "Sending credentials"; the short form is that hosted prod runs on Hetzner and
# three apps (console, marketing, admin) send through @repo/email from one shared .env.
#
# The ACCESS KEY IS NOT CREATED HERE. An aws_iam_access_key resource writes the secret into the
# state, which lives in a bucket many principals can read. The key is minted by the CLI straight
# into the untracked deploy/prod/secrets.local.env and merged into the vault by
# scripts/bootstrap-secrets.sh (README step 5). checks.tftest.hcl's posture run asserts this file's
# shape; the absence of the key resource is a review rule, stated here.

resource "aws_iam_user" "sender" {
  name = var.sender_user_name
  path = "/alethia-email/"

  lifecycle {
    precondition {
      condition     = var.email_account_id != var.alethia_account_id
      error_message = "email_account_id equals alethia_account_id. SES production access was denied in the Alethia platform account; this stack exists to send from the separate alethia-email account."
    }
  }
}

data "aws_iam_policy_document" "sender" {
  statement {
    sid     = "SendAsTheDomainThroughItsConfigSets"
    effect  = "Allow"
    actions = ["ses:SendEmail", "ses:SendRawEmail"]

    # SES authorises a send against the identity AND, when one is named, the configuration set, so
    # both appear. Nothing else in the account can be sent as or through. The set ARNs are BUILT
    # from the same names the sets are created with (main.tf), so the policy renders at plan time.
    resources = concat(
      [data.aws_sesv2_email_identity.domain.arn],
      [for k in sort(tolist(local.streams)) : local.config_set_arns[k]],
    )

    dynamic "condition" {
      for_each = length(var.sender_source_cidrs) > 0 ? [1] : []
      content {
        test     = "IpAddress"
        variable = "aws:SourceIp"
        values   = var.sender_source_cidrs
      }
    }
  }
}

resource "aws_iam_user_policy" "sender" {
  name   = "alethia-ses-send"
  user   = aws_iam_user.sender.name
  policy = data.aws_iam_policy_document.sender.json
}
