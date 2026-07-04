FROM golang:1.25-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

# Copy the workspace root files for multi-module builds
COPY go.work go.work
COPY packages/core/ packages/core/

# Copy alethia module stubs so go.work can resolve all entries
COPY apps/cli/go.mod apps/cli/go.sum apps/cli/

# Copy runner module
COPY apps/runner/go.mod apps/runner/go.sum apps/runner/
RUN cd apps/runner && go mod download

COPY apps/runner/ apps/runner/

ARG VERSION=dev
# TARGETARCH is provided by buildx (defaults to the build host's arch). Fargate
# builds pass --platform linux/arm64; the self-host bundle builds for its host
# (e.g. amd64 on Hetzner CPX, arm64 on Hetzner CAX / Apple Silicon).
ARG TARGETARCH=arm64
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build \
    -ldflags="-s -w -X github.com/alethialabs-io/alethialabs/apps/runner/internal/version.Version=${VERSION}" \
    -o /runner ./apps/runner/cmd/runner

FROM alpine:3.21

RUN apk add --no-cache \
    bash \
    curl \
    unzip \
    git \
    openssh-client \
    aws-cli \
    kubectl \
    helm \
    python3 \
    py3-pip \
    && rm -rf /var/cache/apk/*

# OpenTofu (MPL-2.0) — the IaC engine. Baked in so the runner never downloads it
# at provision time. SHA256-verified against the published SHA256SUMS.
ARG TOFU_VERSION=1.9.0
RUN ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/') && \
    ASSET="tofu_${TOFU_VERSION}_linux_${ARCH}.zip" && \
    cd /tmp && \
    curl -fsSL "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/${ASSET}" -o "${ASSET}" && \
    curl -fsSL "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_SHA256SUMS" -o SHA256SUMS && \
    grep " ${ASSET}\$" SHA256SUMS | sha256sum -c - && \
    unzip "${ASSET}" -d /usr/local/bin tofu && \
    rm -f "${ASSET}" SHA256SUMS && \
    chmod +x /usr/local/bin/tofu

RUN ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/') && \
    curl -fsSL "https://github.com/infracost/infracost/releases/download/v0.10.39/infracost-linux-${ARCH}.tar.gz" | \
    tar -xz -C /usr/local/bin && \
    mv /usr/local/bin/infracost-linux-${ARCH} /usr/local/bin/infracost && \
    chmod +x /usr/local/bin/infracost

RUN ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/') && \
    curl -fsSL "https://github.com/kubernetes-sigs/aws-iam-authenticator/releases/download/v0.7.17/aws-iam-authenticator_0.7.17_linux_${ARCH}" \
      -o /usr/local/bin/aws-iam-authenticator && \
    chmod +x /usr/local/bin/aws-iam-authenticator

# Google Cloud SDK
RUN ARCH=$(uname -m | sed 's/x86_64/x86_64/' | sed 's/aarch64/arm/') && \
    curl -fsSL "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-${ARCH}.tar.gz" | \
    tar -xz -C /opt && \
    /opt/google-cloud-sdk/install.sh --quiet --path-update=true && \
    /opt/google-cloud-sdk/bin/gcloud components install gke-gcloud-auth-plugin --quiet
ENV PATH="/opt/google-cloud-sdk/bin:${PATH}"

# Azure CLI
RUN pip3 install --break-system-packages azure-cli

COPY --from=builder /runner /usr/local/bin/runner

RUN adduser -D -u 1000 runner
USER runner
WORKDIR /home/runner

COPY --chown=runner:runner infra/templates/project/ /home/runner/project-templates/
COPY --chown=runner:runner infra/templates/runner/ /home/runner/runner-templates/
COPY --chown=runner:runner infra/templates/argocd/ /home/runner/argocd-templates/

# Pre-initialize each project template at build time so job-time `tofu init` does no
# network work. Two costs are eliminated, both otherwise paid per job: (1) provider
# downloads (~300–700 MB) — cached into the shared TF_PLUGIN_CACHE_DIR and symlinked
# from each template's .terraform/providers; (2) registry MODULE downloads (~30+
# modules, the larger surprise) — vendored into each template's .terraform/modules.
# We KEEP the resulting .terraform tree; the per-job workdir copy includes it (copyDir
# preserves the provider symlinks), so init only re-runs the S3 backend step (~2 s)
# instead of re-fetching everything (~60–120 s). `-upgrade` pins the lock to this
# build arch; `-backend=false` skips remote state. `runner` is a multi-arch tag but each
# arch is built NATIVELY (deploy-console: runner-amd64 on x86, runner-arm64 on arm — no
# QEMU), so `tofu init` runs on both and the baked tree matches that arch's runtime
# exactly. (An emulated cross-build would crash here with `fatal error: lfstack.push`,
# which is why the build is split per-arch rather than one emulated multi-platform build.)
ENV TF_PLUGIN_CACHE_DIR=/home/runner/.terraform.d/plugin-cache
RUN mkdir -p "${TF_PLUGIN_CACHE_DIR}" && \
    for d in aws azure gcp; do \
      echo "Pre-initializing ${d} template (providers + modules)..." && \
      (cd "/home/runner/project-templates/${d}" && \
        tofu init -backend=false -input=false -upgrade) ; \
    done

ENTRYPOINT ["runner"]
