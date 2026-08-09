# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# SECRETS ENVELOPE ENCRYPTION for ACK (#2004) — encrypts Kubernetes Secrets in etcd under a
# customer-managed KMS key, instead of leaving them under Alibaba's default key.
#
# WHY THIS EXISTS. AWS has done this since the template was written, silently: the upstream
# terraform-aws-modules/eks module defaults `create_kms_key = true` and encrypts `secrets`. GKE, AKS
# and ACK had nothing, and the gap was neither boarded nor excluded — the silent third state the
# cloud-parity rule forbids. ON BY DEFAULT here, to match.
#
# ACK is the SIMPLEST of the three, and worth saying why, because the other two are not: ACK
# performs the encryption through its service-linked role (AliyunCSManagedKubernetesRole), which
# already carries KMS permissions. There is no per-cluster identity to grant first, so no ordering
# problem — unlike GKE (a service agent that must be granted before the cluster is created) and AKS
# (which forced a switch to a user-assigned identity to make the grant expressible at all).
#
# ⚠️ THE KEY OUTLIVES THE CLUSTER, DELIBERATELY. `pending_window_in_days` is the minimum Alibaba
# allows, 7 — long enough that a restored etcd backup is still decryptable during the window, short
# enough that a swept e2e project stops billing quickly. A KMS key cannot be deleted immediately at
# all, so the e2e sweepers must treat a key in PendingDeletion as swept, not as a leak.

locals {
  alibaba_secrets_encryption = var.ack_secrets_encryption_enabled && var.provision_ack
}

resource "alicloud_kms_key" "ack_secrets" {
  count = local.alibaba_secrets_encryption ? 1 : 0

  description = "ACK Kubernetes Secrets envelope encryption — ${local.ack_name}"

  # Aliyun_AES_256 is the algorithm ACK's encryption provider expects; an asymmetric key is rejected.
  key_spec  = "Aliyun_AES_256"
  key_usage = "ENCRYPT/DECRYPT"

  # 7 days is Alibaba's floor. See the header for why the shortest legal window is the right choice
  # here rather than the longest.
  pending_window_in_days = 7

  # Rotation is a no-op for already-encrypted Secrets — the old version is retained — so it is safe
  # to leave on, and it means a long-lived project does not sit on one key material forever.
  automatic_rotation = "Enabled"
  rotation_interval  = "7776000s"
}
