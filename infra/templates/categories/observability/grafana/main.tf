# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Grafana Cloud observability — installs a Grafana Agent (Alloy) that remote-writes
# cluster metrics to Grafana Cloud. Composed by the runner when a Project selects
# Grafana for observability.

terraform {
  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.0"
    }
  }
}

resource "helm_release" "grafana_agent" {
  name             = "grafana-k8s-monitoring"
  repository       = "https://grafana.github.io/helm-charts"
  chart            = "k8s-monitoring"
  namespace        = "monitoring"
  create_namespace = true

  set {
    name  = "externalServices.prometheus.host"
    value = var.grafana_remote_write_url
  }
  set {
    name  = "externalServices.prometheus.basicAuth.username"
    value = var.grafana_instance_id
  }
  set_sensitive {
    name  = "externalServices.prometheus.basicAuth.password"
    value = var.grafana_api_token
  }
}
