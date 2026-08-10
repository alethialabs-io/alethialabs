# The maintainer unblock checklist

Nine units on the board are open, correct, and cannot be finished by anyone but the maintainer.
They are not stalled on code — every one is stalled on a **credential, a grant, a promotion or a
real apply**, which an agent is refused. This file is the worklist.

It exists because the board does not distinguish "unbuilt" from "built and never run". A
harness whose `ALETHIA_E2E_*` variable is never set is **dead but looks shipped**, and
`test/e2e/nightly_reachability_test.go` says so in as many words — it asserts only that the
variables are *referenced* by the workflow, never that they are enabled.

## The one fact behind most of it

```
$ gh variable list
ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID     # …and that is the whole list
```

Every scenario-level gate variable is unset — `E2E_FABRIC_DEMO`, `E2E_SECRETS_XACCT*`,
`E2E_KEYLESS_DB`, `E2E_VCLUSTER`, `E2E_NAMESPACE_TENANT`, `E2E_DAY2_*`, `E2E_BYO_IAC*`,
`E2E_ARGO_*` — and `HCLOUD_TOKEN` is absent from `gh secret list`. So the harnesses built for
#845, #1268, #1450 and #1513 have never executed once.

---

## 0 · Do this first — it is costing money

**Two AWS environments survived teardown and are still standing.**

```
##[error]aws cleanup INCOMPLETE — resources for run 29558347776-1 still exist
##[error]aws cleanup INCOMPLETE — resources for run 30518134684-1 still exist
```

They bill for as long as they stand, and until #2266 landed they also consumed the entire
90-minute nightly job budget on every run — the aws leg provisioned nothing at all on
2026-08-10 because of them. #2266 bounds the sweep so this can no longer eat the job; it does
**not** remove them.

Sweep each, scope-locked, from the repo root:

```bash
ALETHIA_E2E_ENV=29558347776-1 ALETHIA_E2E_REGION=<region> ./scripts/e2e/aws-cleanup.sh
ALETHIA_E2E_ENV=30518134684-1 ALETHIA_E2E_REGION=<region> ./scripts/e2e/aws-cleanup.sh
```

`DRY_RUN=1` lists without deleting. The script refuses any handle that is not a specific
`e2e-<env>`, so it cannot widen to prod.

> Those run IDs long predate current numbering, so this is a **standing** teardown failure
> rather than a one-off. Worth finding out why before the next pair accumulates.

---

## 1 · Set one secret — closes two issues

| unit | action |
|---|---|
| **#1579**, **#1720** | Set the `HCLOUD_TOKEN` repo secret. |

These are one issue in two places: hetzner is the only cloud whose gate is unwired, so the
"1 of 5 clouds are not enabled" rollup closes itself at 5/5 the moment the secret exists.
The gate at `e2e-nightly.yml:201` green-skips hetzner every night until then.

⚠️ The issue asks you to dispatch hetzner alone at floor and run the kill-drill **before**
setting the secret — the account is shared with prod.

---

## 2 · Three cloud grants — closes the CMK security feature (#2262)

`#2092` shipped envelope encryption of Kubernetes Secrets under a customer-managed key, **on by
default**, and it fails on three of five clouds because the deploying identity cannot create the
key. #2269 fixes what is fixable in code; these grants are the rest.

| cloud | grant | to |
|---|---|---|
| gcp | `roles/cloudkms.admin` | the e2e project's provisioning SA |
| azure | **Key Vault Crypto Officer** — the *data-plane* role | the e2e service principal (`oid=1351a7f6-…`) |
| alibaba | a RAM policy allowing `kms:CreateKey` | role `alethia-e2e-nightly` |

⚠️ **Key Vault Reader is not sufficient on Azure** — the failing call is a key *read* on an
RBAC-authorized vault, which is data-plane. Control-plane Owner does not carry it.

Then re-run the nightly and confirm the three legs get past `secrets-encryption.tf`. That real
apply is the only proof that counts here: every one of these passed the plan-time gates.

---

## 3 · Promote `dev` → `main` — clears part of #2099

`packages/core/cloud/subscription_name.go` exists on `origin/dev` and **not** on `origin/main`.
It is the GCP Pub/Sub subscription-name sanitiser (`7662f8bb`, #2216), and without it the gcp
full-bar leg dies on `Invalid resource name given (name=projects/…-arn:aws:sqs:…)`.

The T2 full-bar legs run from `main`, so this needs the promotion, not a fix.

⚠️ Also required for #2099, and account-side: GCP **NodePool quota** on `itgix-adp`
(`Error 429: Insufficient project quota`) and a missing `roles/cloudsql.client` IAM binding.

> Worth knowing generally: the 2026-08-09 full-bar ran headSha `376fe8d9`, dated **2026-08-04**.
> Three of that night's four REDs were already fixed before they were filed. Check
> `git diff origin/main origin/dev` before diagnosing a nightly failure.

---

## 4 · Turn on the harnesses that have never run

Each is built, wired, and has executed zero times.

| unit | action |
|---|---|
| **#845** | Set `E2E_FABRIC_DEMO*`, then dispatch from `main` once per cloud. 0 of 4 clouds are proven; `demos/proofs/` holds no fabric run. |
| **#1268** | Apply the account-B stack, set `E2E_SECRETS_XACCT*`, dispatch aws from `main`, run `secrets-e2e.sh aws strict`, then flip the `*-xacct` catalog rows. GCP/Azure account-B stacks are not written yet. |
| **#1450** | Run a real Azure apply with `E2E_KEYLESS_DB=1`, `ENGINE=mysql`. Positively verify `public_network_access` is **Disabled** — nothing asserts it today. |
| **#1513** | Six real-apply proofs gate this. Only then the default-on decision, then delete the `ALETHIA_KEYLESS_DB_AUTH_ENABLED` read at `packages/core/provisioner/manifests_gen.go:64`, the `Options.KeylessDBAuth` plumbing, the off-path tests, and the docs rollout callout. |

---

## 5 · The ones needing a decision, not just an action

| unit | what only you can settle |
|---|---|
| **#1871** | The GCP budget's alerts are undeliverable. Needs an out-of-band **Cloud Console** grant to `billing-budgets@system.gserviceaccount.com`, then flip `budget_publisher_binding_enabled` to true and `tofu import` the binding. The file's own comment records that this was never attempted. |
| **#1773** | Settle the stable-zone vs `cloud_dns_enabled` tension, then create and delegate the zone. `infra/aws-e2e` does not exist yet; `test/e2e/maxconfig.go:693` still pins `acm_certificate: false`. |
| **#1845** | Run the probe: does an AUTO `alicloud_cr_scan_rule` scan on a **zero-VPC Basic instance**? Create the rule, push a matching tag, poll `GetRepoTagScanStatus`. Not answerable from documentation, and a green offer-parity check **cannot** substitute — a REPO-scoped rule satisfies the guard whether or not a scan runs. |
| **#1065** | Blocked behind **#2058** (loki values) before any cloud can pass the all-add-ons bar. The one real attempt, hetzner on 2026-08-05, failed 12/20 apps unhealthy. |

---

## What this list is not

It is not a backlog of work someone else could pick up. Every item needs a credential, a console
grant, a promotion, or a real cloud apply. If an item ever stops needing one of those, it belongs
back on the claimable board instead of here.
