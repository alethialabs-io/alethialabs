# Licensing

License names below use [SPDX identifiers](https://spdx.org/licenses/). The
default license for this project is [`AGPL-3.0-only`](LICENSE).

**Alethia Labs is open core.** The core is free and open source under the GNU
Affero General Public License v3.0; a small set of cloud / enterprise features is
commercially licensed. Alethia Labs DPK owns the copyright to the entire codebase
(contributions are consolidated via a [CLA](cla/)), which is what lets it offer
the `ee/` features under a separate commercial license while keeping the core AGPL.

## `AGPL-3.0-only` (default)

All files except those listed below are licensed `AGPL-3.0-only` (see `LICENSE`).
This includes, among others:

    apps/console/        apps/cli/        apps/runner/        apps/docs/
    packages/core/   packages/ui/   packages/charts/   packages/eslint-config/
    infra/   deploy/   scripts/   spec/

## `LicenseRef-Alethia-Commercial`

The following directory and its subdirectories are commercially licensed
(see [`ee/LICENSE`](ee/LICENSE)); production use requires a subscription:

    ee/

## `GPL-3.0-only`

The legacy Python CLI predates the open-core split and remains under GPL-3.0:

    apps/legacy-cli/        ->  apps/legacy-cli/LICENSE

## `MIT`

Trivial shared tooling kept permissive on purpose:

    packages/typescript-config/

## Third-party components

Vendored third-party code keeps its original license, for example:

    infra/templates/project/aws/modules/valkey/   ->  Apache-2.0

Full texts of referenced licenses live under [`LICENSES/`](LICENSES/), and
third-party attributions are in [`NOTICE`](NOTICE).

## Network use (AGPL §13)

When you run a **modified** version of the core over a network, AGPL §13 requires
you to offer those users the Corresponding Source of the exact version you run. The
hosted Alethia Labs service publishes the Corresponding Source of the version it
runs (the tagged commit / build the deployment is built from) and surfaces an
in-app source offer linking to it. The commercially-licensed `ee/` code is a
separate work and is not part of the AGPL Corresponding Source. (Whether a given
`ee/` module is a separate work, and the precise §13 mechanism, should be confirmed
with counsel.)
