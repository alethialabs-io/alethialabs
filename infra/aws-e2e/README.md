<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# aws-e2e

The AWS e2e estate, moved into its own AWS account: **`alethia-e2e` (556074788436)**, a member of
the same AWS Organization as the Alethia platform account (270587882865).

Before this stack, the T2 nightly's provisioning role `alethia-e2e-nightly` lived in the platform
account, beside the prod vault (`alethia/prod/env`), the OpenTofu state bucket, ECR, SES and the
OIDC deploy roles. That role holds `iam:*`. `infra/aws-oidc/e2e-nightly.tf` says plainly what a
permissions boundary cannot do: a role that can create *other* unbounded principals can escape a
boundary that binds only itself. That file recommends a dedicated account. This stack is that
account.

| File | What |
|---|---|
| `bootstrap/` | One role, `alethia-e2e-admin`, which the main stack applies through. Applied **once** with the organization's management-account credentials, because only that account can assume `OrganizationAccountAccessRole`. |
| `provider.tf` | Assumes `alethia-e2e-admin`. `allowed_account_ids = [e2e_account_id]`, so the provider refuses to run in any other account, the platform account included. |
| `oidc.tf` | The GitHub Actions OIDC provider. A new account has none, and the provider is per account. |
| `e2e-nightly.tf` | `alethia-e2e-nightly`: the same name, path, trust subjects, boundary and identity policy as `infra/aws-oidc`. It adds denies that protect the ways back into the account (`DenyTamperWithBreakGlass`, `DenyTamperWithTrustAnchors`, `DenyTamperWithCostGuard`) and drops the human `AdminAssume` path. |
| `e2e-broker.tf` | The #4226 assertion-broker trust, with the same contract as `infra/aws-oidc/e2e-broker.tf`. |
| `e2e-budget.tf` | The monthly budget and its SNS topic. The budget now covers the **whole** account, so every dollar it counts is e2e spend. |
| `spend-reporter.tf` | `alethia-spend-reporter`: the weekly spend report's reader in this account. Cost Explorer and `tag:GetResources` only, trusting only `…:environment:spend-report`. Under `/alethia-e2e/`, so the nightly role's boundary forbids it to edit or delete the role. |
| `e2e-dns.tf` | A **second** public zone `e2e.alethialabs.io`, with its apex NS TTL lowered to 300s. |
| `checks.tf` / `checks.tftest.hcl` | Invariants, and a credential-free test that the committed posture plans as claimed and that each refusal and check fires. CI runs it in `.github/workflows/infra-aws-e2e.yml`. |

## Design decisions

**Account access: a bootstrap role, not `OrganizationAccountAccessRole` on every apply.** The
management account belongs to the organization, not to Alethia. If every apply needed its
credentials, every change to the e2e account would need another organization's identity. The
bootstrap uses those credentials once, to create `alethia-e2e-admin`. That role trusts only exact
principal ARNs in the platform account (`ArnEquals` on `aws:PrincipalArn` under the account root,
so a re-provisioned SSO permission set keeps working). After the bootstrap, the maintainer's
ordinary `alethia-sso` session does everything: the backend directly, and the provider through the
role. The management account's id is not written anywhere in this repository. The bootstrap reads
a local profile name from `TF_VAR_management_profile`.

**Trust runs one way only.** The e2e account trusts the platform account. The platform account
trusts nothing in the e2e account. A full compromise of the e2e account, which is the threat this
move is built for, gives no access to prod.

**Where the state lives: the existing platform-account bucket, under new keys.** The keys are
`aws-e2e/bootstrap/terraform.tfstate` and `aws-e2e/terraform.tfstate` in
`alethia-tofu-state-270587882865`. The state is **not** in a bucket in the e2e account, on purpose.
The nightly role holds `s3:*` and `iam:*` there. State in that account could be rewritten by the
role whose guardrails it defines, and the next apply would then "restore" whatever the role wrote.
In the platform account the role has no grant at all, because the bucket is in another account and
has no bucket policy for it. The boundary also denies the bucket by name as defence in depth. The
backend needs no new credentials: it is authenticated by the same `alethia-sso` session as
`infra/aws-oidc`.

**DNS: a new zone of the same name. Cloudflare decides which zone answers.** Route 53 allows a
second public `e2e.alethialabs.io` in another account, and gives it its own four name servers. The
only thing that decides which zone the internet queries is the `e2e` NS record set at Cloudflare,
which is held in `alethialabs.io`. So the cutover is **one Cloudflare edit**, and the rollback is the
same edit in reverse. The old zone (`Z0395392Z0SAB8SFGNLX`, `prevent_destroy` in `infra/aws-oidc`)
is kept unchanged until the new one has been proven. Nothing needs to be copied: measured on
2026-11-14, the old zone holds 296 record sets, and every one is a per-run external-dns leftover
(`argocd.<run>.e2e…` and its TXT ownership markers) or the NS/SOA pair.

**The workflows do not change.** Every AWS e2e workflow reads the role from `vars.E2E_AWS_ROLE_ARN`
(`e2e-nightly`, `e2e-orphan-reaper`, `catalog-drift`, `byo-users-managed-mysql`,
`scripts/e2e/refresh-e2e-issuer-token.mjs`). The nightly takes the account id from
`configure-aws-credentials`, not from the ARN. The ACM proof reads the zone from
`vars.E2E_ACM_CERT_ZONE_ID`. So the switch is **two repo-variable flips**. They must happen
together, because the new role cannot write the old zone and the old role cannot write the new one.
Until someone flips them, nothing reads this stack, and merging it changes nothing that runs.

## Runbook

Run each step from a checkout of `dev` that contains this stack. Each step says what it changes and
how to undo it. Steps 1–4 change nothing that any workflow reads.

### 0. Preflight (read-only)

```bash
AWS_PROFILE=alethia-sso aws sts get-caller-identity --query Account --output text   # 270587882865
AWS_PROFILE=alethia-sso aws iam list-roles --path-prefix /aws-reserved/ --query 'Roles[].Arn'
```

The second command prints the SSO role ARN, **path included**, that goes into the bootstrap's
`admin_principal_arns`.

Check that the old account holds no e2e orphan, because the reaper stops looking there after step 6:

```bash
AWS_PROFILE=alethia-sso aws resourcegroupstaggingapi get-tag-values \
  --key alethia:project-id --region us-east-1 --query 'TagValues[?starts_with(@, `e2e-`)]'
```

### 1. Bootstrap: create `alethia-e2e-admin` (management-account credentials, once)

```bash
cd infra/aws-e2e/bootstrap
cp backend.hcl.example backend.hcl
cp terraform.tfvars.example terraform.tfvars   # paste the SSO role ARN from step 0
AWS_PROFILE=alethia-sso tofu init -backend-config=backend.hcl
AWS_PROFILE=alethia-sso TF_VAR_management_profile=<management-account profile> \
  tofu plan -out=bootstrap.tfplan      # expect: 2 to add, 0 to change, 0 to destroy
AWS_PROFILE=alethia-sso TF_VAR_management_profile=<management-account profile> \
  tofu apply bootstrap.tfplan
```

- **Changes:** one IAM role and one `AdministratorAccess` attachment in 556074788436. One new state
  object in the platform-account bucket. `AWS_PROFILE` authenticates the backend. The provider's own
  `profile` overrides it for the e2e account.
- **Verify:** `AWS_PROFILE=alethia-sso aws sts assume-role --role-arn arn:aws:iam::556074788436:role/alethia-e2e-admin --role-session-name probe --query AssumedRoleUser.Arn`
- **Roll back:** the same two environment variables, then `tofu destroy`. Nothing depends on the
  role yet.

To use the account by hand from now on, add a profile to `~/.aws/config`:

```ini
[profile alethia-e2e-admin]
source_profile = alethia-sso
role_arn       = arn:aws:iam::556074788436:role/alethia-e2e-admin
region         = us-east-1
```

### 2. Quotas (read-only, before anything is provisioned)

A new account starts at **default** service quotas, which can be lower than the ones the platform
account has collected. Compare the two for the quotas a max-config EKS run uses:

```bash
for p in alethia-sso alethia-e2e-admin; do
  for q in ec2:L-1216C47A ec2:L-34B43A08 ec2:L-0263D0A3 vpc:L-F678F1CE vpc:L-FE5A380F; do
    AWS_PROFILE=$p aws service-quotas get-service-quota --region us-east-1 \
      --service-code "${q%%:*}" --quota-code "${q#*:}" --query 'Quota.[QuotaName,Value]' --output text
  done
done
```

Those are on-demand and spot vCPUs, EIPs, VPCs, and NAT gateways per AZ. Where the e2e account is
lower, request an increase (`aws service-quotas request-service-quota-increase`, under the
`alethia-e2e-admin` profile) before step 7.

### 3. Main apply: role, OIDC provider, broker trust, budget, zone

```bash
cd infra/aws-e2e
cp backend.hcl.example backend.hcl
printf 'e2e_budget_alert_emails = ["you@example.com"]\n' > emails.auto.tfvars
AWS_PROFILE=alethia-sso tofu init -backend-config=backend.hcl
AWS_PROFILE=alethia-sso tofu plan -out=aws-e2e.tfplan
AWS_PROFILE=alethia-sso tofu apply aws-e2e.tfplan
```

- **Expect:** `12 + <number of emails>` to add, 0 to change, 0 to destroy. That is two OIDC
  providers (GitHub, broker), the boundary policy, the role and its inline policy, the spend
  reporter role and its inline policy, the SNS topic and its policy, the budget, the zone and its
  apex NS record, plus one email subscription per address. (Applied before `spend-reporter.tf`
  existed? See [The weekly spend report](#the-weekly-spend-report) for the 2-resource apply.)
  The plan must show **no** `check` warning. Read the rendered trust: it names exactly
  `repo:alethialabs-io/alethialabs:ref:refs/heads/main` and `…:environment:e2e-dev`, plus the
  `E2EBrokerAssertion` statement.
- **Changes:** resources in 556074788436 only, and one new state object. Nothing in `infra/aws-oidc`
  changes, and no workflow reads any of it yet.
- **Then:** confirm the SNS subscription email(s).
- **Roll back:** none needed, because nothing points at it. Deleting it is a reviewed PR, since the
  zone is `prevent_destroy`.

### 4. Optional, ≥ 48 h before step 5: shorten the OLD zone's NS TTL

Measured on 2026-11-14: Cloudflare serves the `e2e` delegation at TTL 300, but the old zone's own
apex NS record is **172800**. Resolvers prefer the child zone's copy. So for up to **48 hours**
after step 5, some resolvers, possibly including the ones ACM uses, may still query the old zone.
That TTL is not managed by `infra/aws-oidc`, which owns the zone but not its NS record, so lowering
it causes no tofu drift:

```bash
AWS_PROFILE=alethia-sso aws route53 change-resource-record-sets --hosted-zone-id Z0395392Z0SAB8SFGNLX \
  --change-batch '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"e2e.alethialabs.io.","Type":"NS","TTL":300,
  "ResourceRecords":[{"Value":"ns-1073.awsdns-06.org."},{"Value":"ns-1616.awsdns-10.co.uk."},{"Value":"ns-167.awsdns-20.com."},{"Value":"ns-931.awsdns-52.net."}]}}]}'
```

- **Changes:** one TTL in the platform account's zone. Its records stay the same.
- **Roll back:** the same command with `"TTL":172800`.
- **Skip it** and wait 48 h after step 5 before relying on step 7's ACM proof instead.

The new zone's apex NS is already 300 (`e2e_dns_ns_ttl`), so a rollback *from* the new zone takes
effect in minutes.

### 5 + 6. Cutover: Cloudflare NS and the two variables, in one sitting

Do these together and away from the scheduled run (`17 3 * * *` UTC). Between the two edits, an AWS
run's ACM proof writes to a zone that no longer answers.

**5. Cloudflare (a dashboard edit; no stack in this repo manages it).** In the `alethialabs.io`
zone, under DNS, replace the values of the four `NS` records named `e2e` with the four from:

```bash
AWS_PROFILE=alethia-sso tofu -chdir=infra/aws-e2e output -json e2e_dns_zone_name_servers
```

Verify:

```bash
dig +short NS e2e.alethialabs.io @kianchau.ns.cloudflare.com   # the parent: new four, at once
dig +short NS e2e.alethialabs.io @1.1.1.1                      # resolvers: new four once the old TTL expires
dig +short NS e2e.alethialabs.io @8.8.8.8
```

- **Roll back:** put the old four back: `ns-1073.awsdns-06.org`, `ns-1616.awsdns-10.co.uk`,
  `ns-167.awsdns-20.com`, `ns-931.awsdns-52.net`. The old zone is unchanged.

**6. Repo variables.** First record the current values. They are the rollback.

```bash
gh variable get E2E_AWS_ROLE_ARN       # arn:aws:iam::270587882865:role/alethia-e2e/alethia-e2e-nightly
gh variable get E2E_ACM_CERT_ZONE_ID   # Z0395392Z0SAB8SFGNLX
gh variable set E2E_AWS_ROLE_ARN     --body "$(AWS_PROFILE=alethia-sso tofu -chdir=infra/aws-e2e output -raw e2e_nightly_role_arn)"
gh variable set E2E_ACM_CERT_ZONE_ID --body "$(AWS_PROFILE=alethia-sso tofu -chdir=infra/aws-e2e output -raw e2e_dns_zone_id)"
```

The new role ARN is `arn:aws:iam::556074788436:role/alethia-e2e/alethia-e2e-nightly`. These
variables **do not change**: `E2E_ACM_CERT_ZONE_NAME` (`e2e.alethialabs.io`), `E2E_ACM_CERT`,
`E2E_BYO_IAC`, `E2E_ISSUER_URL` and `E2E_ISSUER_GITHUB_AUDIENCE`. The broker holds no AWS account
or role list.

- **Roll back:** `gh variable set` both back to the recorded values, **and** undo step 5. Do both,
  for the same reason the forward steps go together.

### 7. Prove it: one floor run and one keyless run

These are paid dispatches, priced by `.claude/hooks/guard-spend.sh` against the shared budget. Run
them one at a time:

```bash
gh workflow run e2e-nightly.yml --ref dev -f provider=aws -f dimension=floor
gh workflow run e2e-nightly.yml --ref dev -f provider=aws -f dimension=floor -f keyless_db=postgres
```

Green means the following, per run:

- The `Configure AWS credentials` step resolves account **556074788436**. The nightly prints it
  (`AWS_ACCOUNT_ID resolved for the T2 harness`).
- The floor run's ACM scenario (`E2E_ACM_CERT=1`) issues against the **new** zone. That is the proof
  that the delegation works.
- The always() cleanup and `VERIFY_ONLY` report clean for the run.

Also confirm that the next `e2e-orphan-reaper` run reads the new account. To prove the broker path
before the nightly does, run `node scripts/e2e/refresh-e2e-issuer-token.mjs` from a dispatch. It
names `E2E_AWS_ROLE_ARN` in its refusal if the `E2EBrokerAssertion` trust is not applied.

**Roll back** at any point here with step 6's rollback, then step 5's.

### 8. Cleanup PR (later, after step 7 is green)

A separate, reviewed PR, applied by the maintainer:

- Remove `e2e-nightly.tf`, `e2e-broker.tf`, `e2e-budget.tf`, `e2e-dns.tf`, their `checks.tf` blocks,
  outputs, variables and `terraform.tfvars` lines from `infra/aws-oidc`. The zone's
  `prevent_destroy` has to be removed in that PR. Route 53 deletes a zone only when it holds nothing
  but NS and SOA, so the 296 leftover record sets go first.
- Drop `infra/aws-oidc/terraform.tfvars` from `PATHS.trustTfvars` in
  `scripts/ci/check-e2e-issuer-health.mjs`.
- Update the prose that still names the shared account: `scripts/e2e/aws-cleanup.sh`'s header
  ("the SHARED platform account"), `scripts/e2e/nightly-rollup.sh`, the `infra/.trivyignore`
  comments, `infra/README.md`, and `e2e-nightly.yml`'s comments pointing at `infra/aws-oidc`.

## The weekly spend report

A member account's Cost Explorer sees only its own spend. So after step 6, the platform account's
`alethia-spend-reporter` no longer sees any AWS e2e spend. `spend-reporter.tf` adds a second
reporter here, and `spend-report.yml` reads both accounts and sums them. If this stack was applied
before `spend-reporter.tf` existed, apply only the reporter:

```bash
cd infra/aws-e2e
AWS_PROFILE=alethia-sso tofu plan  -target=aws_iam_role.spend_reporter -target=aws_iam_role_policy.spend_reporter
#   expect: 2 to add, 0 to change, 0 to destroy
AWS_PROFILE=alethia-sso tofu apply -target=aws_iam_role.spend_reporter -target=aws_iam_role_policy.spend_reporter
gh variable set SPEND_REPORTER_E2E_ROLE_ARN --body "$(AWS_PROFILE=alethia-sso tofu output -raw spend_reporter_role_arn)"
```

The role trusts `repo:alethialabs-io/alethialabs:environment:spend-report`, the same subject as the
platform reporter. That environment is already restricted to `main` (`infra/github`), so there is no
ordering constraint. Setting the variable before step 6 is harmless: the report then shows the e2e
account at zero.

## Not moved by this stack, and what each needs

- **The cross-account secrets lane** (`infra/aws-secrets-e2e`, `E2E_SECRETS_XACCT_*`, not enabled
  today). Its `cluster_account_id` is "account A", the account the cluster runs in. That becomes
  556074788436 when the lane is enabled.
- **The cross-account registry lane** (`E2E_XACCT_REGISTRY_*`, not enabled today). It needs a
  target registry that is not the e2e account.
- **An organization SCP** on `alethia-e2e`, for example a region lock or a deny on
  `organizations:LeaveOrganization`, would be stronger than any policy inside the account. It can
  only be attached from the management account, so it is not in this repository.
