<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Evidence — driving alethialabs.io, 2026-08-29

Browser (Claude in Chrome) plus the shipped CLI 0.5.0, against production, org `tovr`.
**Cloud spend: $0.00** — nothing reached `tofu apply`.

## What was exercised

| Surface | Result |
|---|---|
| `/tovr` overview | renders; **defect** — "Recent jobs · last 24h" listing month-old jobs |
| `/tovr/~/clusters` | honest empty state |
| `/tovr/~/new` | three entry paths + design-agent prompt; renders well |
| `/tovr/~/new?scratch=template` | **defect confirmed** — default env matrix hits the orphan-Fabric bug |
| `/tovr/~/jobs`, `/tovr/a640/jobs` | filters, facets and rows render; row → job navigation is wired (`jobs-client.tsx:174`) |
| `alethia whoami · connector list · provider status · runner list · fleet list` | all fine |
| `alethia project create/component add/plan` | **3 CLI/doc defects** (below) |
| `alethia verify show` on a live job | real per-control output |

## Screenshot

`20260829-new-project-placement-defaults.png` — the new-project template flow, showing
`production` + `staging` as **Dedicated** and `dev` + `preview` as **Namespace**. Under the code
prod serves today, the two namespace tiers land on a Fabric no environment owns, so they can never
deploy. This is the default path, not an edge case.

## Defects found

1. **#3348 — prod cannot provision AWS or GCP.** The deployed runner runs as `self` with no ambient
   cloud credentials; the PLAN job dies before tofu with an error naming EC2 IMDS. Azure, Alibaba and
   the token clouds are unaffected (no operator gate) — an Azure plan **succeeded** on the same
   runner, job `0d9850b1`. There are also no fleet pools.
2. **#3318 — MCP OAuth discovery is unreachable.** The 401 advertises a `resource_metadata` URL that
   returns the console's HTML shell.
3. **`terraform_data` denied SCOPE-001.** Every committed receipt in `demos/proofs/` reads
   `not_evaluable` for this reason alone, on every cloud. Fixed on this branch.
4. **`--set cluster_version=1.31` is refused** — coerced to a number, the field is a string. Quote
   it: `--set 'cluster_version="1.31"'`.
5. **`--project-id` takes the UUID, not the name**; `plan`/`apply`/`destroy` prompt for a runner
   without `--runner-id` and so die under `--no-input` with a message that reads like a complaint
   about the project.
6. **Overview "last 24h"** applies no time window. Fixed on this branch.

## Checked and NOT a defect

- **Jobs-table row navigation.** A synthetic click did not navigate, but `jobs-client.tsx:174` does
  `router.push('/{org}/~/jobs/{id}')`. A tooling artifact, not a product bug — recorded so nobody
  re-files it.

## Worth a look, not filed

- The primary CTAs on `/{org}/~/new` ("Start from a template", "Blank project") and the job rows
  expose **no accessible name** in the a11y tree — a screen reader reads them as "button".
- Five consecutive weekly **Detect Drift** failures on `a640` (Azure) sit on the org overview. Cause
  not established; the same runner runs Azure plans successfully, so it is not #3348.
