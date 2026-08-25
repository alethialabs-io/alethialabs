# The maintainer unblock checklist

The units on the board that are open, correct, and cannot be finished by anyone but the
maintainer. They are not stalled on code — every one is stalled on a **credential, a grant, a
promotion or a real apply**, which an agent is refused. This file is the worklist. The sections
below enumerate it; there is deliberately no count in this sentence, because a count in a header
is a guaranteed future lie (this one said "nine" while listing eleven).

It exists because the board does not distinguish "unbuilt" from "built and never run". A
harness whose `ALETHIA_E2E_*` variable is never set is **dead but looks shipped**, and
`test/e2e/nightly_reachability_test.go` says so in as many words — it asserts only that the
variables are *referenced* by the workflow, never that they are enabled.

## The one fact behind most of it

**The five CLOUD GATES are wired. Every SCENARIO gate is not.** Those are different things, and
conflating them sends you to the wrong place:

| layer | state |
|---|---|
| cloud gate — decides whether a leg provisions at all | `E2E_AWS_ROLE_ARN`, `E2E_GCP_WIF_PROVIDER` + `E2E_GCP_SA_EMAIL`, the three `E2E_AZURE_*` + `ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID`, `E2E_ALIBABA_ROLE_ARN` + `_OIDC_PROVIDER_ARN` are all **set** (2026-08-03). Only **`HCLOUD_TOKEN`** is missing — see §1. |
| scenario gate — decides what a provisioned leg proves | **none are set**: `E2E_FABRIC_DEMO`, `E2E_SECRETS_XACCT*`, `E2E_KEYLESS_DB`, `E2E_VCLUSTER`, `E2E_NAMESPACE_TENANT`, `E2E_DAY2_*`, `E2E_BYO_IAC*`, `E2E_ARGO_*`, and the `E2E_GIT_TOKEN` secret. |

So four of five clouds provision and converge every night, and the harnesses built for #845,
#1268, #1450 and #1513 have never executed once.

> An earlier version of this section pasted a `gh variable list` output showing only
> `ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID`. That was already stale when it was written and it
> contradicted §1 of this same file. Re-run `gh variable list` rather than trusting a paste.

---

## 0 · Do this first — it is holding a quota, not a lot of money

**Two AWS environments survived teardown and are still standing.**

```
##[error]aws cleanup INCOMPLETE — resources for run 29558347776-1 still exist
##[error]aws cleanup INCOMPLETE — resources for run 30518134684-1 still exist
```

Right action, and it is worth being exact about the reason, because the money framing is wrong
and would get this deprioritised. #2288 measured the live account: ~28 of the 30 tagged `e2e-*`
handles hold only a **`PendingDeletion` KMS key**, which AWS does not bill, and those deletion
windows expire on their own between 2026-08-17 and 09-08. Run-rate is about **$1/month**.

What actually hurts is that they hold **2 of the 5 VPCs** in `us-east-1`. Every future aws leg
needs one, so this is a quota wall on the whole cloud, not a line on an invoice. They also
consumed the entire nightly job budget on every run until #2266 bounded the sweep — the aws leg
provisioned nothing at all on 2026-08-10 because of it. #2266 stops the sweep eating the job; it
does **not** remove these.

**Sweep from a `dev` checkout, not `main`.** `18867d25` (#2288) is what makes them removable at
all: it added VPC-endpoint sweeping (a Gateway endpoint had blocked `delete-vpc` on every nightly
since 2026-07-17) and a two-pass strip-then-delete for the mutually-referencing EKS cluster/node
security-group pair. `main`'s copy of the script cannot succeed on these two — it is the loop
that ate the budget.

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

## 0.5 · Make the e2e federation authoritative — **two applies and one import, not four applies**

#2462 says "four applies". Planned against live state on 2026-08-25 that is wrong in a way that
costs a failed apply, so the breakdown lives here and the commands live in
**`docs/testing/e2e-federation-apply-runbook.md`**:

| stack | action | why |
|---|---|---|
| `infra/gcp-e2e` | **apply** | the e2e SA holds `roles/browser` and no `roles/cloudkms.admin`; #2295 was committed and never applied, so `gcp/floor` dies in `secrets-encryption.tf` (#2258) |
| `infra/alibaba-e2e` | **apply** | `+kms:*`, and `oidc:sub` is still a **scalar** — alibaba cannot be dispatched from `dev` at all |
| `infra/azure-e2e` | **import** | `gh-oidc-env` exists live but is absent from state; an apply **collides** instead of converging |
| `infra/aws-oidc` | **nothing** | both subjects present and state agrees — a diff here means you passed a different `e2e_budget_alert_emails`, not drift |

## 1 · Set one secret — closes two issues

| unit | action |
|---|---|
| **#1579**, **#1720** | Set the `HCLOUD_TOKEN` repo secret. |

These are one issue in two places: hetzner is the only cloud whose gate is unwired, so the
"1 of 5 clouds are not enabled" rollup closes itself at 5/5 the moment the secret exists.
The gate at `e2e-nightly.yml:201` green-skips hetzner every night until then.

⚠️ The issue asks you to dispatch hetzner alone at floor and run the kill-drill **before**
setting the secret — the account is shared with prod.

That warning is about the **account**, and the remedy is the **project**. Mint the token inside
`alethia-infra-tests`, which the 2026-08-24 preflight measured as completely empty: a Hetzner API
token is scoped to one project and cannot see another, so a token minted there has no prod blast
radius and the kill-drill is not a precondition. Minting it in `tovr-prod` or any
`alethia-*-prod` context is the thing #1579 is actually warning against.

---

## 2 · The CMK feature (#2262) — a promotion and two applies, **not** three console grants

`#2092` shipped envelope encryption of Kubernetes Secrets under a customer-managed key, **on by
default**, and run 31356854945 failed on three of five clouds — gcp, azure, alibaba — all at
`tofu apply`, all inside the new `secrets-encryption.tf`. That is one cause, not three bugs, and
it is why #2258, #2259 and #2260 are one unit.

This section used to ask for three Cloud Console grants. **Two of the three were already code,
and doing them by hand would have been worse than useless** — `google_project_iam_member` and
`azurerm_role_assignment` are non-authoritative, so a hand grant survives an apply *silently and
undocumented*, and `infra/gcp-e2e/checks.tf` treats the committed role list as the source of
truth. What each cloud actually needs:

| cloud | what it needs | why |
|---|---|---|
| **azure** | **nothing but the promotion** | #2269 makes the template self-grant `azurerm_role_assignment.provisioner_crypto_officer` at vault scope, and the e2e SP already holds **User Access Administrator** (`infra/azure-e2e/roles.tf:31-36`), which carries `roleAssignments/write`. |
| **alibaba** | `tofu apply infra/alibaba-e2e` | `kms:*` has been committed at `infra/alibaba-e2e/roles.tf:67` since #2269 — it just has not been applied. |
| **gcp** | `tofu apply infra/gcp-e2e`, after #2295 | #2295 adds `roles/cloudkms.admin` **and** replaces `roles/browser` with `alethiaE2eProjectReader`. The second is the one that would have bitten: #2269's plan-time guard reads `data.google_project_service.cloudkms`, which needs `serviceusage.services.get`, and `roles/browser` carries no serviceusage permission at all. Without it the promotion moves the gcp red from an apply-time KMS 403 to a **plan-time `serviceusage` error that never mentions KMS**. |

⚠️ **Ordering:** land #2295 *before* the §3 promotion, or you diagnose gcp twice.

⚠️ Historical note, still true of any hand grant: **Key Vault Reader is not sufficient on Azure** —
the failing call is a key *read* on an RBAC-authorized vault, which is data-plane, and
control-plane Owner does not carry it.

Then re-run the nightly and confirm the three legs get past `secrets-encryption.tf`. That real
apply is the only proof that counts here: every one of these passed the plan-time gates.

---

## 3 · Promote `dev` → `main` — clears part of #2099

`packages/core/cloud/subscription_name.go` exists on `origin/dev` and **not** on `origin/main`.
It is the GCP Pub/Sub subscription-name sanitiser (`7662f8bb`, #2216), and without it the gcp
full-bar leg dies on `Invalid resource name given (name=projects/…-arn:aws:sqs:…)`.

The T2 full-bar legs run from `main`, so this needs the promotion, not a fix.

⚠️ Also required for #2099, and account-side: GCP **NodePool quota** on the Alethia E2E project
(`Error 429: Insufficient project quota`) and a missing `roles/cloudsql.client` IAM binding.

> Worth knowing generally: the 2026-08-09 full-bar ran headSha `376fe8d9`, dated **2026-08-04**.
> Three of that night's four REDs were already fixed before they were filed. Check
> `git diff origin/main origin/dev` before diagnosing a nightly failure.

---

## 4 · Turn on the harnesses that have never run

Each is built, wired, and has executed zero times.

| unit | action |
|---|---|
| **#845** | `gh variable set E2E_FABRIC_DEMO --body 1`, then dispatch from `main` **one cloud at a time**, then **delete the variable again**. 0 of 4 clouds are proven; `demos/proofs/` holds no fabric run. Leave the companions (`_REPO`/`_OVERLAYS`/`_VCLUSTER`/`_TIMEOUT`) unset — every default is correct, and per #2301 they are deliberately flat-only. See the two warnings below. |
| **#1268** | Apply the account-B stack, set `E2E_SECRETS_XACCT*`, dispatch aws from `main`, run `secrets-e2e.sh aws strict`, then flip the `*-xacct` catalog rows. GCP/Azure account-B stacks are not written yet. |
| **#1450** | Run a real Azure apply with `E2E_KEYLESS_DB=1`, `ENGINE=mysql`. Positively verify `public_network_access` is **Disabled** — nothing asserts it today. **Set the per-cloud siblings if the leg differs** — `E2E_KEYLESS_DB_ENGINE_VERSION_AZURE` and friends only started reaching the harness in #2301; before that the workflow forwarded none of them, so a variable set per the docs had no effect and the run died claiming a required value was unset. |
| **#1513** | Six real-apply proofs gate this. Only then the default-on decision, then delete the `ALETHIA_KEYLESS_DB_AUTH_ENABLED` read at `packages/core/provisioner/manifests_gen.go:64`, the `Options.KeylessDBAuth` plumbing, the off-path tests, and the docs rollout callout. |

⚠️ **Two things about `E2E_FABRIC_DEMO` that cost real money if you get them wrong.**

*It must be truthy, not merely present.* The job and step caps key on `!= ''` while the harness
keys on `t2Truthy` (`1|true|yes|on`). So `E2E_FABRIC_DEMO=0` raises the cap on **all five** clouds
and runs the scenario on none of them.

*The 165→210-minute cap is global, not per-cloud.* The moment the variable is non-empty every leg
inherits it, hetzner and alibaba included, whether or not the scenario runs there. A fabric-demo
night is roughly **$6 for four proofs** and about **$180/month** if left on the cron. Dispatch it;
do not cron it. `ALETHIA_E2E_SOAK=off` (accepted since #2305) frees 25m of the ctx if you need it.

Do **not** enable `E2E_NAMESPACE_TENANT` or `E2E_VCLUSTER` the same night: their budgets sum into
one ctx (`ResolveT2Budget`), `cmd/t2budget` will refuse the run at the top of the step, and the
fabric demo already places two namespace tiers and a vcluster itself.

Since #2299 the shape is handled for you — `E2E_FABRIC_DEMO` truthy loads
`test/e2e/fixtures/cluster_json.demo.<cloud>.json`, and a pre-spend guard refuses a pool too small
to schedule three boutique copies. Before that fix, enabling this variable could not have succeeded
on any cloud: the demo ran on the cheapest floor shape (one `e2-small`, 2 GiB, on gcp) against a
workload measured at 4.91 vCPU / 4.14 GiB, and burned the full cap on four clouds to say so.

---

## 5 · The ones needing a decision, not just an action

| unit | what only you can settle |
|---|---|
| **#1871** | The GCP budget's alerts are undeliverable. Needs an out-of-band **Cloud Console** grant to `billing-budgets@system.gserviceaccount.com`, then flip `budget_publisher_binding_enabled` to true and `tofu import` the binding. The file's own comment records that this was never attempted. |
| **#1773** | Settle the stable-zone vs `cloud_dns_enabled` tension, then create and delegate the zone. `infra/aws-e2e` does not exist yet; `test/e2e/maxconfig.go:693` still pins `acm_certificate: false`. |
| **#2283** | Run the probe: does an AUTO `alicloud_cr_scan_rule` scan on a **zero-VPC Basic instance**? Create the rule, push a matching tag, poll `GetRepoTagScanStatus`. Not answerable from documentation, and a green offer-parity check **cannot** substitute — a REPO-scoped rule satisfies the guard whether or not a scan runs. (This entry named **#1845**, which is closed; #2283 is the open successor — it asks for the proof, where #1845 shipped the wiring.) |
| **#1065** | **No longer blocked — reclassify off this list.** It was blocked behind **#2058** (loki values), which is closed and whose fix is already on `origin/main`: `apps/console/lib/addons/catalog.ts` pins `read`/`write`/`backend` to `replicas: 0` with the load-bearing-zero comment. So the all-add-ons bar on gcp + azure is a `workflow_dispatch` away, gated only on the GCP NodePool quota in §3. The one real attempt, hetzner on 2026-08-05, failed 12/20 apps unhealthy — before that fix. |

---

## What this list is not

It is not a backlog of work someone else could pick up. Every item needs a credential, a console
grant, a promotion, or a real cloud apply. If an item ever stops needing one of those, it belongs
back on the claimable board instead of here.
