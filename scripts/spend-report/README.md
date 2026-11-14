<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# spend-report

One email a week: what every cloud cost, compared with the week before, plus every resource that
still carries an e2e handle. Sent by `.github/workflows/spend-report.yml` every Monday at 07:00 UTC
to `vars.SPEND_REPORT_TO` (default `borislav@alethialabs.io`), through `@repo/email` (Resend). The
Resend key is read from AWS Secrets Manager `alethia/prod/env`. No GitHub secret was added.

## What each line means

| Line | Meaning |
|---|---|
| **7 days** | The last seven complete UTC days, Monday to Sunday. Today is never included, because today's costs are still arriving. |
| **WoW** | Week on week: those seven days against the seven before them. The total only compares clouds that have **both** weeks, so a cloud with no prior week does not show up as growth. |
| **MTD** | Month to date, from the 1st up to yesterday. It is `n/a` on the 1st. |
| **EUR / native** | Each amount is shown in EUR (converted with the ECB reference rate of the day) and in the cloud's own currency. If no rate is available, the EUR column is `n/a`. |
| **(estimate)** | Hetzner only. Hetzner has no billing API. The figure is the resources that exist **now**, priced at the project's own `GET /pricing` list prices (net, excl. VAT). A week is `min(hourly × 168, monthly)`. It does not count traffic, or anything created and deleted during the week. |
| **not readable — reason** | That cloud could not be read this week. The reason names the variable or the refusal. The run still succeeds. |
| **Red flags** | A cloud whose 7-day EUR spend is over its threshold, or any leaked resource. A cloud with only an MTD figure is held to `MTD × 7 / days elapsed`, and the flag says so. |
| **Top 10 line items** | The largest services or resources across all clouds, in EUR, each labelled with its basis (7 days, month to date, est. 7 days). |
| **Leak list** | Resources that still exist and carry an e2e handle: `alethia:project-id=e2e-*`, or `alethia:e2e-run=e2e-<run>-<attempt>` (`alethia_*` labels on Hetzner). This is the selector the sweepers use (`scripts/e2e/lib/scope-key.sh`), and a test fails if the two drift apart. AWS is scanned in `SPEND_AWS_LEAK_REGIONS`. Hetzner is scanned across the whole project. Azure, GCP and Alibaba are **not** scanned. If no cloud could be scanned, the leak list says "not known". It never says "none found" in that case. |

Per cloud:

- **AWS**: Cost Explorer `GetCostAndUsage`, `UnblendedCost`. One daily query grouped by `SERVICE`,
  and one 7-day query for each tag key in `SPEND_AWS_TAG_KEYS` (default `alethia:project-id`,
  `alethia:environment-id`, `alethia:e2e-run`). A tag breakdown is useful only after the tag is
  **activated** as a cost-allocation tag in Billing. Until then every cost shows as `(untagged)`,
  and the email says so. AWS bills each Cost Explorer request at USD 0.01, so the defaults cost
  4 requests (USD 0.04) a week. Set `SPEND_AWS_GROUP_BY_LINKED_ACCOUNT=true` once the account is an
  Organization's **payer**. The same role then also reports spend per member account. On a
  standalone account that breakdown has one row.
- **Azure**: the Cost Management query API (`ActualCost`, daily, by `ServiceName`), scoped to the e2e
  subscription.
- **GCP**: the Budget API stores a budget's **amount** but not its spend. Spend appears only in the
  budget's Pub/Sub notifications (`costAmount`, month to date). The report reads its own
  subscription on `alethia-e2e-nightly-budget-alerts` and does not acknowledge the messages, so
  each run sees the last 7 days of notifications. MTD is the latest notification. The 7-day figure
  is approximate: the difference between the earliest and the latest notification in the window.
  If the billing account is **closed**, the email says so plainly.
- **Hetzner**: the estimate above, for the project that `secrets.HCLOUD_TOKEN` belongs to (the e2e
  project). The production Hetzner project and the sandbox box are **not** included.
- **Alibaba**: BSS `QueryBillOverview`, tried with the **existing** e2e RAM role. For now it reports
  "not readable", for two reasons. The role's trust admits the `main` ref subject, not the
  `spend-report` environment. And its policy has no `bss:*` permission. Neither is widened here.

## Run it

```bash
# Dispatch (from main only; the job skips on any other ref). dry_run=true builds the report into the
# job summary and does not send the email.
gh workflow run spend-report.yml --ref main -f dry_run=true

# Locally, the pure half (no cloud, no network):
pnpm -F @repo/spend-report test
```

The run fails in **one** case only: the email could not be sent. When that happens, the report is
already in the job summary.

## Apply (maintainer, in this order)

Every identity trusts **one** OIDC subject: `repo:alethialabs-io/alethialabs:environment:spend-report`.
The environment is what limits that subject to `main`. GitHub **creates an environment with no
restrictions** the first time a job names one that does not exist. So the environment comes
first, before the workflow reaches `main` and before the AWS role exists.

```bash
# 1. The environment, restricted to main (infra/github/environments.tf). Adds 2 resources.
cd infra/github && tofu init -backend-config=backend.hcl && \
  tofu apply -target=github_repository_environment.spend_report \
             -target=github_repository_environment_deployment_policy.spend_report_main

# 2. AWS: the alethia-spend-reporter role (infra/aws-oidc/spend-reporter.tf). Adds 2 resources.
cd infra/aws-oidc && tofu init -backend-config=backend.hcl && \
  tofu apply -target=aws_iam_role.spend_reporter -target=aws_iam_role_policy.spend_reporter
gh variable set SPEND_REPORTER_ROLE_ARN -b "$(tofu output -raw spend_reporter_role_arn)"

# 3. Azure: a separate Cost-Management-Reader app (infra/azure-e2e/spend-reporter.tf). Adds 4 resources.
cd infra/azure-e2e && tofu init -backend-config=backend.hcl && \
  tofu apply -var "subscription_id=<e2e subscription>" \
    -target=azuread_application.spend_reporter -target=azuread_service_principal.spend_reporter \
    -target=azuread_application_federated_identity_credential.spend_reporter \
    -target=azurerm_role_assignment.spend_reporter_cost_reader
gh variable set SPEND_AZURE_CLIENT_ID -b "$(tofu output -raw spend_reporter_client_id)"

# 4. GCP: the spend-reporter SA + billing viewer + a pull subscription (infra/gcp-e2e/spend-reporter.tf).
#    Adds 6 resources. Changes NO pool or provider, so the dispatch trust stays as it is.
cd infra/gcp-e2e && tofu init -backend-config=backend.hcl && \
  tofu apply -var "project_id=<e2e project>" -var "billing_account_id=<XXXXXX-XXXXXX-XXXXXX>" \
    -target='google_project_service.apis["cloudbilling.googleapis.com"]' \
    -target=google_service_account.spend_reporter -target=google_service_account_iam_member.spend_reporter_wif \
    -target=google_billing_account_iam_member.spend_reporter_viewer \
    -target=google_pubsub_subscription.spend_reporter -target=google_pubsub_subscription_iam_member.spend_reporter_subscriber
gh variable set SPEND_GCP_SA_EMAIL            -b "$(tofu output -raw spend_reporter_sa_email)"
gh variable set SPEND_GCP_BUDGET_SUBSCRIPTION -b "$(tofu output -raw spend_reporter_subscription)"
gh variable set SPEND_GCP_BILLING_ACCOUNT     -b "<XXXXXX-XXXXXX-XXXXXX>"
```

Each stack still needs the inputs its own README requires. `infra/aws-oidc` and `infra/azure-e2e`
need `e2e_budget_alert_emails`, which goes in their gitignored `emails.auto.tfvars`. `infra/github`
needs `github_token` (`TF_VAR_github_token`).

The applies use `-target` on purpose. The committed `terraform.tfvars` of `azure-e2e` and `gcp-e2e`
also contain the e2e broker trust (`e2e_broker_issuer_url`). An apply without `-target` would also
create that trust, and those stacks' READMEs say it must be applied last. Run `tofu plan` with the
same `-target`s first. The plan should only **add** resources.

## Repository variables

| Variable | Default | Meaning |
|---|---|---|
| `SPEND_REPORT_TO` | `borislav@alethialabs.io` | The recipient. |
| `SPEND_REPORT_THRESHOLDS_EUR` | `{"aws":30,"azure":15,"gcp":15,"hetzner":30,"alibaba":10}` | Red-flag limits, **EUR per 7 days**, as JSON. Name only the clouds you want to change, for example `{"aws":50}`. A malformed value falls back to the defaults, and the email says so. |
| `SPEND_REPORTER_ROLE_ARN` | — | Output of step 2. Without it, AWS is not readable **and the email cannot be sent**: the Resend key is in AWS. |
| `SPEND_AWS_TAG_KEYS` | `alethia:project-id,alethia:environment-id,alethia:e2e-run` | Cost-allocation tags to break AWS spend down by. |
| `SPEND_AWS_GROUP_BY_LINKED_ACCOUNT` | `false` | `true` on an Organization payer account. |
| `SPEND_AWS_LEAK_REGIONS` | `us-east-1` | Regions the AWS leak scan reads (the tagging API is regional; `us-east-1` is `e2e_region`). |
| `SPEND_AZURE_CLIENT_ID` | — | Output of step 3. The tenant and subscription come from the existing `E2E_AZURE_TENANT_ID` and `E2E_AZURE_SUBSCRIPTION_ID`. |
| `SPEND_GCP_SA_EMAIL`, `SPEND_GCP_BUDGET_SUBSCRIPTION`, `SPEND_GCP_BILLING_ACCOUNT` | — | From step 4. The WIF provider comes from the existing `E2E_GCP_WIF_PROVIDER`. |
| `SPEND_ALIBABA_BSS_ENDPOINT` | `business.ap-southeast-1.aliyuncs.com` | The BSS endpoint (international accounts). |

The Alibaba role comes from the existing `E2E_ALIBABA_ROLE_ARN` / `E2E_ALIBABA_OIDC_PROVIDER_ARN`.
Hetzner uses the existing `secrets.HCLOUD_TOKEN`.

## Known limits

- **The AWS role can read the whole `alethia/prod/env` secret, not only `RESEND_API_KEY`.** Secrets
  Manager grants `GetSecretValue` per secret, not per JSON key. `alethia-deploy-reader` already has
  the same reach. To narrow it, the Resend key would need its own secret.
- Nothing here is armed in the coverage ratchet yet (`vitest.config.ts` explains why).
- Pricing and parsing are tested against payloads in each provider's documented response shape.
  Whether the live APIs still return that shape is shown by the first dispatch, not by a unit test.
