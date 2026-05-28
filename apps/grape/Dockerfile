FROM golang:1.25-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /grape .

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

COPY --from=builder /grape /usr/local/bin/grape

RUN adduser -D -u 1000 grape
USER grape
WORKDIR /home/grape

ENTRYPOINT ["grape"]
CMD ["worker", "start"]
