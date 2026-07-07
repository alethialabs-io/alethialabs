# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Full multi-cloud runner image — `runner` (co-located on the control-plane box + the fleet). Builds FROM
# the shared runner-base (Go binary + tofu + infracost + kubectl/helm + user + shared templates) and adds
# ALL three clouds' CLIs + all three project templates + init. Built multi-arch (amd64 box, arm64 fleet) by
# deploy-console.yml. No ALETHIA_RUNNER_PROVIDERS → claims jobs for every cloud.

ARG RUNNER_BASE=ghcr.io/alethialabs-io/runner-base:latest
FROM ${RUNNER_BASE}

# All three clouds' CLIs (root). aws-cli pulls python3; gcloud needs python3; azure-cli via pip.
RUN apk add --no-cache aws-cli python3 py3-pip && rm -rf /var/cache/apk/*

# AWS — EKS auth plugin.
RUN ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/') && \
    curl -fsSL "https://github.com/kubernetes-sigs/aws-iam-authenticator/releases/download/v0.7.17/aws-iam-authenticator_0.7.17_linux_${ARCH}" \
      -o /usr/local/bin/aws-iam-authenticator && \
    chmod +x /usr/local/bin/aws-iam-authenticator

# GCP — Google Cloud SDK + GKE auth plugin.
RUN ARCH=$(uname -m | sed 's/x86_64/x86_64/' | sed 's/aarch64/arm/') && \
    curl -fsSL "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-${ARCH}.tar.gz" | \
    tar -xz -C /opt && \
    /opt/google-cloud-sdk/install.sh --quiet --path-update=true && \
    /opt/google-cloud-sdk/bin/gcloud components install gke-gcloud-auth-plugin --quiet
ENV PATH="/opt/google-cloud-sdk/bin:${PATH}"

# Azure — Azure CLI via pip.
RUN pip3 install --break-system-packages azure-cli

# All three project templates (the shared runner + argocd templates come from the base).
COPY --chown=runner:runner infra/templates/project/ /home/runner/project-templates/

USER runner
WORKDIR /home/runner

# Pre-initialize each project template at build time so job-time `tofu init` does no network work — see
# Dockerfile.base for the rationale. Each arch is built natively so the baked .terraform matches the
# runtime arch. TF_PLUGIN_CACHE_DIR is inherited from the base.
RUN for d in aws azure gcp; do \
      echo "Pre-initializing ${d} template (providers + modules)..." && \
      (cd "/home/runner/project-templates/${d}" && tofu init -backend=false -input=false -upgrade) ; \
    done

ENTRYPOINT ["runner"]
