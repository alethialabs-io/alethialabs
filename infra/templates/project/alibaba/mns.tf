# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

module "mns" {
  source = "./modules/mns"
  count  = var.create_mns ? 1 : 0

  queues = var.mns_queues
  topics = var.mns_topics
}
