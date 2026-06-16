# Runtime image for the alethia CLI.
# Built by GoReleaser (`dockers:` in .goreleaser.yml): the prebuilt, cross-compiled
# `alethia` binary is provided in the build context — do NOT compile here.
FROM alpine:3.21

RUN apk add --no-cache ca-certificates git openssh-client && rm -rf /var/cache/apk/*

COPY alethia /usr/local/bin/alethia

RUN adduser -D -u 1000 alethia
USER alethia
WORKDIR /home/alethia

ENTRYPOINT ["alethia"]
