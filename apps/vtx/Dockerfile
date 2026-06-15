FROM golang:1.25-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /vtx .

FROM alpine:3.21

RUN apk add --no-cache \
    bash \
    curl \
    git \
    openssh-client \
    aws-cli \
    kubectl \
    helm \
    && rm -rf /var/cache/apk/*

COPY --from=builder /vtx /usr/local/bin/vtx

RUN adduser -D -u 1000 vtx
USER vtx
WORKDIR /home/vtx

COPY --chown=vtx:vtx templates/ /home/vtx/templates/
COPY --chown=vtx:vtx templates-worker/ /home/vtx/templates-worker/
COPY --chown=vtx:vtx templates-argocd/ /home/vtx/templates-argocd/

ENTRYPOINT ["vtx"]
