# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Docker Hub — pluggable alternative to the cloud-native container registry.
# Rather than creating cloud registry repos, this wires a Kubernetes
# imagePullSecret so workloads can pull from Docker Hub. Composed by the runner
# when a Project selects Docker Hub; the native registry (ECR/AR/ACR) is guarded off
# via `registry_provider` in project/<cloud>.

terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
  }
}

locals {
  dockerconfig = jsonencode({
    auths = {
      "https://index.docker.io/v1/" = {
        username = var.dockerhub_username
        password = var.dockerhub_access_token
        auth     = base64encode("${var.dockerhub_username}:${var.dockerhub_access_token}")
      }
    }
  })
}

resource "kubernetes_secret" "dockerhub_pull" {
  metadata {
    name      = "dockerhub-pull"
    namespace = var.namespace
  }
  type = "kubernetes.io/dockerconfigjson"
  data = {
    ".dockerconfigjson" = local.dockerconfig
  }
}
