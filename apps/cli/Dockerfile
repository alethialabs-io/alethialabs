FROM golang:1.25-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /alethia .

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

COPY --from=builder /alethia /usr/local/bin/alethia

RUN adduser -D -u 1000 alethia
USER alethia
WORKDIR /home/alethia

COPY --chown=alethia:alethia templates/ /home/alethia/templates/
COPY --chown=alethia:alethia templates-worker/ /home/alethia/templates-worker/
COPY --chown=alethia:alethia templates-argocd/ /home/alethia/templates-argocd/

ENTRYPOINT ["alethia"]
