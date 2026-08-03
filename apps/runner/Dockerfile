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
#
# NO `-upgrade`: the committed .terraform.lock.hcl decides the provider versions, and `-upgrade`
# disregards the lock file and re-resolves against the registry. With it, the image would bake whatever
# was newest at BUILD time while the e2e nightly resolved separately — so the run that proves
# production works would install a different provider set than production ships (#1259).
RUN for d in aws azure gcp alibaba hetzner; do \
      echo "Pre-initializing ${d} template (providers + modules)..." && \
      (cd "/home/runner/project-templates/${d}" && tofu init -backend=false -input=false) ; \
    done


# The runner's own image ref, baked at build time (#1787). Several renders schedule the runner binary
# as somebody else's sidecar or Job — the keyless DB auth proxy and its bootstrap Job, the xacct
# registry-token refresher — and each fails closed without a ref. It used to be read from
# ALETHIA_RUNNER_IMAGE, which nothing that shipped ever set, so those renders silently refused on
# every deployed runner. The build knows the answer; the operator should not have to.
#
# The default is deliberately EMPTY. A locally built image has no published ref, and baking a guessed
# one would name a different image than the one running — worse than the explicit refusal. Publishing
# workflows pass the FINAL multi-arch tag, never a per-arch one: this ref becomes a sidecar on the
# customer's nodes, so an arm64-only manifest would be unpullable on amd64 nodes.
ARG SELF_IMAGE=""
ENV ALETHIA_RUNNER_SELF_IMAGE=${SELF_IMAGE}
ENTRYPOINT ["runner"]
