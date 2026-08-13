# Alethia Enterprise Edition

SPDX-License-Identifier: LicenseRef-Alethia-Commercial

This directory contains source-visible enterprise functionality. It is not
licensed under the repository's AGPL default. Review [`LICENSE`](LICENSE) before
using any file in this directory.

## Boundary rules

- The community application must install, build, test, and run with this directory absent.
- Community code may reference only the single optional enterprise loader.
- Enterprise code receives capabilities through the registration interface; it
  must not reach into community internals through additional runtime imports.
- `ALETHIA_EDITION=community` never loads this package.
- `ALETHIA_EDITION=enterprise` fails if this package is absent or broken.
- `ALETHIA_EDITION=auto` loads the package when present and otherwise runs community mode.
- Every file in this directory uses `LicenseRef-Alethia-Commercial`.
- Enterprise dependencies must pass the proprietary-artifact dependency policy.

These rules improve engineering separation and reproducible community builds.
They are not a declaration that every enterprise module is legally a separate
copyright work.

## Copyright status

ALETHIA LABS is registered as a Bulgarian single-member variable capital company
under EIK 208913663. Founder-created enterprise code remains part of the founder's
pre-incorporation works until a written assignment to the company is executed.
External contributors retain copyright and must be covered by the
active contribution agreement before their work is accepted.

## Production use

Source visibility is not a production licence. Production use requires a valid
commercial subscription or order agreement with the registered Alethia entity.
The repository licence is not a substitute for an MSA, order form, support terms,
or data-processing agreement.
