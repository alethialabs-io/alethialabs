FROM golang:1.25-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

# Copy the workspace root files for multi-module builds
COPY go.work go.work
COPY packages/grape-core/ packages/grape-core/

# Copy grape module stubs so go.work can resolve all entries
COPY apps/grape/go.mod apps/grape/go.sum apps/grape/

# Copy tendril module
COPY apps/tendril/go.mod apps/tendril/go.sum apps/tendril/
RUN cd apps/tendril && go mod download

COPY apps/tendril/ apps/tendril/

ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build \
    -ldflags="-s -w -X github.com/bobikenobi12/bb-thesis-2026/apps/tendril/internal/version.Version=${VERSION}" \
    -o /tendril ./apps/tendril/cmd/tendril

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
    curl -fsSL "https://releases.hashicorp.com/terraform/1.7.4/terraform_1.7.4_linux_${ARCH}.zip" -o /tmp/tf.zip && \
    unzip /tmp/tf.zip -d /usr/local/bin && \
    rm /tmp/tf.zip && \
    chmod +x /usr/local/bin/terraform

RUN ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/') && \
    curl -fsSL "https://github.com/infracost/infracost/releases/download/v0.10.39/infracost-linux-${ARCH}.tar.gz" | \
    tar -xz -C /usr/local/bin && \
    mv /usr/local/bin/infracost-linux-${ARCH} /usr/local/bin/infracost && \
    chmod +x /usr/local/bin/infracost

# Google Cloud SDK
RUN ARCH=$(uname -m | sed 's/x86_64/x86_64/' | sed 's/aarch64/arm/') && \
    curl -fsSL "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-${ARCH}.tar.gz" | \
    tar -xz -C /opt && \
    /opt/google-cloud-sdk/install.sh --quiet --path-update=true && \
    /opt/google-cloud-sdk/bin/gcloud components install gke-gcloud-auth-plugin --quiet
ENV PATH="/opt/google-cloud-sdk/bin:${PATH}"

# Azure CLI
RUN pip3 install --break-system-packages azure-cli

COPY --from=builder /tendril /usr/local/bin/tendril

RUN adduser -D -u 1000 tendril
USER tendril
WORKDIR /home/tendril

COPY --chown=tendril:tendril infra/templates/vine/ /home/tendril/vine-templates/
COPY --chown=tendril:tendril infra/templates/tendril/ /home/tendril/tendril-templates/
COPY --chown=tendril:tendril infra/templates/argocd/ /home/tendril/argocd-templates/

ENTRYPOINT ["tendril"]
