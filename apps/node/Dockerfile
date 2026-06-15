FROM golang:1.25-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

# Copy the workspace root files for multi-module builds
COPY go.work go.work
COPY packages/vertex-core/ packages/vertex-core/

# Copy vtx module stubs so go.work can resolve all entries
COPY apps/vtx/go.mod apps/vtx/go.sum apps/vtx/

# Copy node module
COPY apps/node/go.mod apps/node/go.sum apps/node/
RUN cd apps/node && go mod download

COPY apps/node/ apps/node/

ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build \
    -ldflags="-s -w -X github.com/bobikenobi12/bb-thesis-2026/apps/node/internal/version.Version=${VERSION}" \
    -o /node ./apps/node/cmd/node

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

COPY --from=builder /node /usr/local/bin/node

RUN adduser -D -u 1000 node
USER node
WORKDIR /home/node

COPY --chown=node:node infra/templates/vine/ /home/node/vine-templates/
COPY --chown=node:node infra/templates/node/ /home/node/tendril-templates/
COPY --chown=node:node infra/templates/argocd/ /home/node/argocd-templates/

ENTRYPOINT ["node"]
