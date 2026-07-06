# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Datadog observability — installs the Datadog agent into the cluster. Composed by
# the runner when a Project selects Datadog for observability (a pluggable-only
# category with no cloud-native default).

terraform {
  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.0"
    }
  }
}

resource "helm_release" "datadog" {
  name             = "datadog"
  repository       = "https://helm.datadoghq.com"
  chart            = "datadog"
  namespace        = "datadog"
  create_namespace = true

  set {
    name  = "datadog.site"
    value = var.datadog_site
  }
  set_sensitive {
    name  = "datadog.apiKey"
    value = var.datadog_api_key
  }
  set_sensitive {
    name  = "datadog.appKey"
    value = var.datadog_app_key
  }
}
