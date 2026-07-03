# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Prometheus observability — installs kube-prometheus-stack in-cluster, optionally
# remote-writing to an external Prometheus-compatible store. Composed by the runner
# when a Project selects Prometheus for observability.

terraform {
  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.0"
    }
  }
}

locals {
  remote_write_values = var.prometheus_remote_write_url == "" ? "" : yamlencode({
    prometheus = {
      prometheusProject = {
        remoteWrite = [{
          url = var.prometheus_remote_write_url
          basicAuth = var.prometheus_remote_write_username == "" ? null : {
            username = { name = "prom-remote-write", key = "username" }
            password = { name = "prom-remote-write", key = "password" }
          }
        }]
        retention = "${var.prometheus_retention_days}d"
      }
    }
  })
}

resource "helm_release" "kube_prometheus_stack" {
  name             = "kube-prometheus-stack"
  repository       = "https://prometheus-community.github.io/helm-charts"
  chart            = "kube-prometheus-stack"
  namespace        = "monitoring"
  create_namespace = true

  values = local.remote_write_values == "" ? [] : [local.remote_write_values]

  set {
    name  = "prometheus.prometheusProject.retention"
    value = "${var.prometheus_retention_days}d"
  }
}
