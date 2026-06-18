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

RUN ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/') && \
    curl -fsSL "https://releases.hashicorp.com/terraform/1.10.3/terraform_1.10.3_linux_${ARCH}.zip" -o /tmp/tf.zip && \
    unzip /tmp/tf.zip -d /usr/local/bin && \
    rm /tmp/tf.zip && \
    chmod +x /usr/local/bin/terraform

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

COPY --chown=runner:runner infra/templates/spec/ /home/runner/spec-templates/
COPY --chown=runner:runner infra/templates/runner/ /home/runner/runner-templates/
COPY --chown=runner:runner infra/templates/argocd/ /home/runner/argocd-templates/

ENTRYPOINT ["runner"]
