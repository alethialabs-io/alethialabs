# Licensing

Alethia is a public open-core project. Licence identifiers below use SPDX
identifiers. This file maps repository paths to their governing terms; it does
not replace the licence texts.

## Repository licence map

| Path                                                                              | Licence                         | Notes                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| Default, including `apps/`, `infra/`, `deploy/`, `scripts/`, and most `packages/` | `AGPL-3.0-only`                 | Community core                                                                           |
| `ee/`                                                                             | `LicenseRef-Alethia-Commercial` | Source-visible enterprise code; production use requires an executed commercial agreement |
| `apps/legacy-cli/`                                                                | `GPL-3.0-only`                  | Legacy Python CLI                                                                        |
| `packages/enterprise-api/`                                                        | `Apache-2.0`                    | Edition-neutral registration protocol; contains no Enterprise implementation             |
| `packages/typescript-config/`                                                     | `MIT`                           | Permissive shared configuration                                                          |
| Identified vendored files                                                         | Their original licence          | The file-level notice and `THIRD_PARTY_NOTICES.md` control                               |

When a file carries its own SPDX identifier, that file-level identifier controls.
The default AGPL licence applies only when no more specific repository exception
or third-party notice applies.

## Copyright and post-registration status

ALETHIA LABS EDPK is registered in Bulgaria under EIK 208913663. Founder-created
pre-incorporation works remain owned by the founder until the prepared written
assignment to the company is signed. External contributors retain copyright
in their contributions and grant rights under the applicable project licence and,
after activation, the Contributor Licence Agreement.

The CLA is a licence, not a copyright assignment. It is intended to give the
registered company sufficient rights to offer accepted contributions under both
open-source and commercial terms. It must not be described as consolidating
ownership.

See [`COPYRIGHT.md`](COPYRIGHT.md) for the current chain-of-title status.

## AGPL community core

The community core is licensed under GNU Affero General Public License version 3
only. A licensee that modifies the covered program and lets users interact with
that modified version remotely through a computer network must provide those
users a qualifying opportunity to receive the Corresponding Source under AGPL
section 13. Distribution of copies can create additional source and notice
obligations under the licence.

The copyright holder may offer its own code under additional licences. That does
not permit Alethia to override the licence of third-party AGPL code or code for
which it lacks sufficient relicensing rights.

Program output, customer configuration, Terraform, manifests, and other generated
material are not automatically AGPL-covered merely because Alethia processed
them. Separate analysis is required if generated output contains substantial
copyrightable portions of covered source.

## Enterprise code

Files in `ee/` are not offered under the AGPL. Public visibility of their source
does not itself grant production, distribution, or sublicensing rights.
Repository access is governed by [`ee/LICENSE`](ee/LICENSE); production use
requires a separate executed subscription or order agreement.

The architectural boundary is maintained through one optional registration
interface and a community build that operates with `ee/` absent. Architecture
alone does not settle whether components are separate works under copyright law.
Alethia does not rely on repository layout as a legal conclusion.

## Source transparency

Each hosted release records its source commit and links to the community source
from `/legal/source`. Release automation can create an archive with:

```sh
scripts/create-community-source.sh <commit>
```

The archive excludes `ee/` and CLA signature records. This transparency promise
does not expand the commercial licence or make enterprise files AGPL-covered.

## Contributions

Third-party contributions remain paused until a versioned ICLA or CCLA is active
for ALETHIA LABS EDPK and the required CLA
status check must pass before outside contributions may merge. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`cla/README.md`](cla/README.md).

## Third-party software

Third-party software remains under its own terms. Required attribution and
licence information belong in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
and release SBOMs. A dependency's presence in a package lockfile does not mean it
is shipped in every Alethia artifact.
