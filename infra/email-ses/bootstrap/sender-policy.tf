# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Scoped send permission for the runtime sender. The user already exists (its
# access key is the one in the app's env) and is NOT managed here — we only
# attach an inline policy limited to our identities + configuration sets, so the
# live key is never touched. Lives in bootstrap (not the main stack) so the
# deploy role needs no iam:*.

data "aws_iam_user" "sender" {
  user_name = var.sender_user_name
}

data "aws_iam_policy_document" "sender_send" {
  statement {
    sid       = "SendScopedToAlethiaStreams"
    effect    = "Allow"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = concat(local.identity_arns, local.config_set_arns)
  }
}

resource "aws_iam_user_policy" "sender_send" {
  name   = "alethia-ses-send"
  user   = data.aws_iam_user.sender.user_name
  policy = data.aws_iam_policy_document.sender_send.json
}
