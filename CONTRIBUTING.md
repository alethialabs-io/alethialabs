# Contributing to Alethia Labs

Thanks for your interest in contributing! Alethia Labs is an **open-core** project:
the core is open source under `AGPL-3.0-only`, and a small set of enterprise
features under [`ee/`](ee/) is commercially licensed. This guide explains how to
contribute and the one legal step we require.

## Contributor License Agreement (CLA)

Before we can merge your contribution, you must sign our Contributor License
Agreement. We enforce it with **CLA Assistant** (the GitHub Action committed at
`.github/workflows/cla.yml`): the first time you open a pull request, a bot asks
you to sign the Individual CLA in-line by commenting. It takes about a minute and
is remembered for future PRs. (CLA enforcement activates once the repository is
hosted at `github.com/alethialabs-io/alethialabs`.)

- **Individuals** sign the [Individual CLA](cla/ICLA.md) via the bot.
- **Contributing on behalf of an employer?** Your employer must also have a
  countersigned [Corporate CLA](cla/CCLA.md) on file (email it to
  legal@alethialabs.io) **before** your PR is merged — the in-PR signature records
  only the Individual CLA.

**Why a CLA?** Alethia Labs offers both an AGPL core and a commercial edition. To
keep offering both, Alethia OÜ needs the right to license your contribution under
both licenses. The CLA grants Alethia OÜ that right while **you keep the copyright
to your contribution** — it is a license, not an assignment. Without it, a single
AGPL-only contribution would block us from shipping the commercial edition.

## How to contribute

1. Fork the repo and create a branch from `main`.
2. Make your change. Add an SPDX header to every new source file:
   - Core code: `SPDX-License-Identifier: AGPL-3.0-only`
   - Code under `ee/`: `SPDX-License-Identifier: LicenseRef-Alethia-Commercial`
   - Plus a copyright line: `SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>`
3. Match the existing code style and run the relevant checks:
   `turbo build`, `turbo lint`, and `go test ./...` for Go packages.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) — releases are
   automated with release-please.
5. Open a pull request and sign the CLA when prompted.

## Reporting security issues

Please do **not** open public issues for security vulnerabilities. Email
security@alethialabs.io instead.

## License

By contributing, you agree that your contributions are licensed under
`AGPL-3.0-only` and, per the CLA, may also be offered by Alethia OÜ under its
commercial license. See [LICENSE](LICENSE) and [LICENSING.md](LICENSING.md).
