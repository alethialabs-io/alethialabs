# syntax=docker/dockerfile:1
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Full multi-cloud runner image — `runner` (co-located on the control-plane box + the fleet). Builds FROM
# the shared runner-base (Go binary + tofu + infracost + kubectl/helm + user + shared templates) and adds
# ALL five project templates + init. CLI-free: every cloud's cluster auth is minted in-process by the
# runner (`runner kube-token --provider <cloud>`) — no aws-cli / gcloud SDK / azure-cli. Built multi-arch
# (amd64 box, arm64 fleet) by deploy-console.yml. No ALETHIA_RUNNER_PROVIDERS → claims jobs for every cloud.

ARG RUNNER_BASE=ghcr.io/alethialabs-io/runner-base:latest
FROM ${RUNNER_BASE}

# All five project templates (the shared runner + argocd templates come from the base).
COPY --chown=runner:runner infra/templates/project/ /home/runner/project-templates/

USER runner
WORKDIR /home/runner

# Pre-initialize each project template at build time so job-time `tofu init` does no network work — see
# Dockerfile.base for the rationale. Each arch is built natively so the baked .terraform matches the
# runtime arch. TF_PLUGIN_CACHE_DIR is inherited from the base.
RUN for d in aws azure gcp alibaba hetzner; do \
      echo "Pre-initializing ${d} template (providers + modules)..." && \
      (cd "/home/runner/project-templates/${d}" && tofu init -backend=false -input=false -upgrade) ; \
    done

ENTRYPOINT ["runner"]
