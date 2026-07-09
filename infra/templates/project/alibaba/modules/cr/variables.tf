# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "instance_name" {
  type        = string
  description = "Name of the Container Registry Enterprise Edition instance"
}

variable "namespace_name" {
  type        = string
  description = "Name of the registry namespace to create"
}
