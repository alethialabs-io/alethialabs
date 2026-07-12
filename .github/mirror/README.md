# alethia

The command-line interface for **[Alethia](https://alethialabs.io)** — the multi-cloud
Kubernetes control plane. Plan, deploy, and tear down infrastructure across AWS, GCP, Azure,
and Hetzner from your terminal.

> **📖 Read-only mirror.** This repository mirrors `apps/cli` (+ its shared `packages/core`) from
> the [alethialabs-io/alethialabs](https://github.com/alethialabs-io/alethialabs) monorepo and is
> kept in sync automatically. Browse the source and file issues here — but **open pull requests
> against the monorepo** (see [CONTRIBUTING](./CONTRIBUTING.md)); PRs opened here can't be merged.

## Install

```bash
# macOS / Linux — Homebrew
brew install alethialabs-io/tap/alethia

# macOS / Linux — install script
curl -fsSL https://get.alethialabs.io | sh

# Windows — Scoop
scoop bucket add alethia https://github.com/alethialabs-io/scoop-bucket
scoop install alethia

# Docker
docker run --rm ghcr.io/alethialabs-io/alethia --version
```

Linux `.deb`/`.rpm`/`.apk` packages and prebuilt binaries are attached to each
[release](https://github.com/alethialabs-io/alethialabs/releases). See the full install matrix in
the [docs](https://alethialabs.io/docs/cli/installation).

## Build from source

```bash
cd apps/cli
go build -o alethia .
./alethia --version
```

## Documentation

https://alethialabs.io/docs/cli

## License

[AGPL-3.0-only](./LICENSE) © Alethia Labs.
