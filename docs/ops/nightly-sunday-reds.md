<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# The Sunday nightly reds (2026-11-01, 11-08, 11-15)

Investigation for #6776 (REL-L2), read on 2026-11-17. Read-only: runs, jobs, the steps API and job
logs of `.github/workflows/e2e-nightly.yml`. Nothing was dispatched, re-run or cancelled.

**Short answer.** The three Sunday reds have three different causes, none of them in the product's
provisioning path and none of them related to the day of the week. Two were GitHub answering 5xx
(11-01, 11-08) and one was a rejected fixture-repo token (11-15). The four launch clouds have been
green on both nights since. The four `contested` floor cells in `PROGRAMME.md` are a one-refresh
display of the 11-15 reds and clear on the next snapshot refresh with no other action.

Reading the logs did surface one real product defect that the nightly reports green over: the
product's own destroy fails on AWS on every night sampled (section 4). It is outside this unit's
scope and is described there, not fixed.

How each failing step was found: `GET /repos/{repo}/actions/runs/{run}/jobs`, selecting steps whose
`conclusion` is `failure`, then the job log from `GET /repos/{repo}/actions/jobs/{job}/logs`. Every
scheduled run below has `event=schedule` and `head_branch=main`: a `schedule:` trigger runs the
default branch's tree, so these runs test `main`, not `dev`.

## 1. The three Sundays

| Date | Run | `main` SHA | Clouds red | Failing step (steps API) | Cause | Class |
|---|---|---|---|---|---|---|
| 11-01 | 41297407846 | `dc1d415bb` | gcp only | 39 `T2 — real runner provisions a real cloud cluster` | BYO-IaC sub-scenario: `tofu init` could not fetch the provider checksums, `500 Internal Server Error returned from github.com` | External (GitHub) |
| 11-08 | 42470800384 | `dc1d415bb` | hetzner, aws, gcp, azure | 14 `Run opentofu/setup-opentofu@v2`, then 48 `Guaranteed teardown` | The OpenTofu release download answered `Unexpected HTTP response: 504`. Nothing was provisioned. Step 48 then failed because the tools the skipped steps install were absent (`the 'hcloud' CLI is not installed`; gcp `cleanup UNVERIFIED`) | External (GitHub), then a rig follow-on |
| 11-15 | 43705941979 | `703d40d94` | hetzner, aws, gcp, azure | 39 `T2 — real runner provisions a real cloud cluster` | The token for the private e2e fixture repositories was rejected by GitHub | Credentials |

What differs on Sundays: nothing. The same `main` SHA `dc1d415bb` ran green on the six days between
11-01 and 11-08 and on the day after 11-08. The 11-01 and 11-08 causes are upstream availability
and the 11-15 cause is a secret; three consecutive Sundays is a coincidence of three unrelated
events. Other reds in the same eight weeks fell on other days (10-23 Fri, 10-24 Sat, 10-12 Mon,
10-13 Tue).

### 11-15 in detail: one shared cause, not four

| Issue | Cloud | Job | Cluster provisioned | Platform add-ons | Failed assertion |
|---|---|---|---|---|---|
| #6715 | hetzner | 132786959011 | yes, receipt verified | Healthy+Synced | `t2_provision_test.go:854` |
| #6716 | aws | 132786959051 | yes, receipt verified | Healthy+Synced | `t2_provision_test.go:854` |
| #6717 | gcp | 132786958998 | yes, receipt verified | Healthy+Synced | `t2_provision_test.go:854` |
| #6718 | azure | 132794790249 | yes, receipt verified | Healthy+Synced | `t2_provision_test.go:854` |

The same two Applications failed on every cloud, with the same message:

```
A0.6 ArgoCD-with-repos convergence failed: ... did not all reach Healthy+Synced within 12m30s:
  - addon-byo-e2e: health=Healthy sync=Unknown [ComparisonError: ... failed to list refs:
    authentication required: Invalid username or token. Password authentication is not supported for Git operations.]
  - apps: health=Healthy sync=Unknown [ComparisonError: ... same message]
```

and the runner had already said so during the deploy:

```
Warning: GitOps add-on sync skipped: clone apps repo: authentication failed: https://github.com/alethialabs-io/alethia-e2e-apps
```

Both Applications read from private fixture repositories with the `E2E_GIT_TOKEN` secret. Evidence
that the secret, not the code, was the variable:

- The run before it (43584972602, 11-14 10:22Z) passed the same assertion.
- `gh secret list` shows `E2E_GIT_TOKEN` last updated `2026-11-15T12:56:42Z`, 39 minutes after the
  red run finished at 12:17Z.
- The next scheduled run (43855704868, 11-16) ran the **same** `main` SHA `703d40d94` and passed on
  all four clouds. Same tree, different secret value, opposite result.

So it was neither product, nor quota, nor a gate: the cluster, the signed receipt and every platform
add-on were good on all four clouds. The test rig's fixture credential was invalid for one night.

**What closed the issues:** a manual close by the maintainer account on 2026-11-16 at 12:44Z, 21
minutes after run 43855704868 finished green, with a comment citing that run. No fix PR was needed
or made. The comment's claim that each provider job ran its full step list is correct for the four
launch clouds (59 to 60 steps, 16 to 70 minutes each).

## 2. Every nightly since

| Date | Run | `main` SHA | hetzner | aws | gcp | azure | alibaba |
|---|---|---|---|---|---|---|---|
| 11-15 | 43705941979 | `703d40d94` | red | red | red | red | gate off |
| 11-16 | 43855704868 | `703d40d94` | green (job 133259367111) | green (133259366964) | green (133259367003) | green (133267562353) | gate off |
| 11-17 | 44077358655 | `439e52f5c` | green (134023583610) | green (134023583405) | green (134023583516) | green (134034126361) | gate off |

"Green" was checked in the logs, not taken from the job conclusion: each leg logs
`all N asserted ArgoCD Applications are Healthy+Synced (0 withheld)` (5 on hetzner, 8 on aws).

Alibaba is not a launch cloud and never provisions: its job finishes in about 25 seconds with
`T2 real-cloud proof SKIPPED for alibaba — ... E2E_ALIBABA_ROLE_ARN ... is not set`. The job
conclusion is `success`, but the rollup counts the leg as a red (`reds: alibaba`). Two bookkeeping
consequences worth knowing:

- The 11-16 close also closed #2545 (`alibaba RED (floor)`, open since August), although alibaba had
  not passed. The 11-17 rollup therefore filed it again as #6810. It will be refiled every time it
  is closed until the scheduled set drops alibaba, which is ALI-L4's unit.
- The four manual dispatches on `dev` on 11-14 and 11-15 (43592824666, 43722379866, 43734395743,
  43747878988) are `workflow_dispatch` runs for another unit, each red on its aws leg. They are not
  nightlies and are not part of this record.

## 3. Why the four floor cells read `contested`

The rule is in `scripts/programme-rollup.mjs`. A cell is `proven` when the proof ledger's surviving
claim is PASS and its bundle is a committed path. A nightly red writes no ledger row, it only files
an issue, so the rollup reads the issue board from `docs/testing/programme-snapshot.json` and marks
a proven cell `contested` in two cases:

| Case | Condition | Clears when |
|---|---|---|
| Open red | An **open** `e2e nightly: <cloud> RED (<dimension>)` issue filed after the run that proved the cell | The issue is closed, or a FAIL row is appended |
| Window-closed red | Such an issue that is **closed**, with `closedAt` at or after the snapshot's `previous_derived_at` | The next snapshot refresh, whose window starts later |

In both cases a ledger proof dated on or after the red makes the red "answered" and the cell stays
proven.

The four cells are in the second case. The snapshot on `dev` has
`previous_derived_at = 2026-11-12T17:08:23Z` and `derived_at = 2026-11-16T18:57:51Z`. #6715 to #6718
were filed 11-15 12:17Z and closed 11-16 12:44Z, inside that window, and the floor ledger rows are
dated 2026-09-29 and 2026-09-30, before the reds. The generated text says the same thing: "CLOSED
2026-11-16 inside this refresh window, so no derivation ever saw it open".

**What has to happen: one snapshot refresh, nothing else.** `scripts/programme-fetch.sh` sets
`previous_derived_at` to the `derived_at` of the snapshot it replaces, so the next refresh has a
window starting 2026-11-16T18:57:51Z, the four closes fall before it, and the cells return to
proven. This was checked rather than inferred: with only the two timestamps moved forward and the
issue lists unchanged, the rollup renders `29 of 36 proof cells are proven · 0 contested` and all
four floor cells as proven (the two files were restored afterwards). `programme.yml` refreshes the
snapshot daily into the long-lived `chore/programme-ledger-refresh` pull request; the previous one,
#6692, sat open from 11-13 to 11-17, which is why the window was four days wide.

No newer proof bundle is needed and no issue is left to close. Nothing is still wrong on the four
launch clouds' floor; the cell is doing what it was built to do, showing once a red that no earlier
derivation saw.

One limit of the grid worth stating, since it is easy to read more into "proven": the floor cells
rest on committed bundles from 2026-09-29/30. A green nightly does not advance that date, because
its proof is a CI artifact and not a committed path. The nightly keeps a cell from being contested;
it does not re-prove it.

## 4. Product defects on the golden path

**On the path sign-up → connect → create → deploy → running cluster: none.** In all three Sunday
reds the product either was never reached (11-08), failed on an upstream 500 in a sub-scenario
after the cluster was up (11-01), or delivered a working cluster with a verified signed receipt and
healthy platform add-ons (11-15).

Two things the logs show that are product behaviour rather than rig behaviour. Neither is in this
unit's scope (`docs/ops/nightly-sunday-reds.md` only), so neither is changed here.

### 4.1 AWS: the product's destroy fails every night, and the nightly is green over it

Real defect, off the provisioning path but on the customer's destroy path.

| Night | Run | aws job | Nightly verdict | Product destroy |
|---|---|---|---|---|
| 10-25 | 40176375075 | 121117872490 | green | failed |
| 11-02 | 41433182108 | 125236636612 | green | failed |
| 11-09 | 42609206327 | 129133013921 | green | failed |
| 11-14 | 43584972602 | 132417429715 | green | failed |
| 11-15 | 43705941979 | 132786959051 | red (other cause) | failed |
| 11-16 | 43855704868 | 133259366964 | green | failed |
| 11-17 | 44077358655 | 134023583405 | green | failed |

Seven of seven sampled, identical each time. Hetzner, gcp and azure log
`teardown: cluster destroyed via RunDestroy` on the same nights. The aws sequence:

```
ArgoCD Applications marked for deletion (they self-heal what follows otherwise).
Releasing 1 cloud-backed object(s) before destroy: ingress/argocd/argo-cd-argocd-server
WARNING — cloud load balancers may still exist and still bill: 1 object(s) still held after 4m0s:
  ingress/argocd/argo-cd-argocd-server — their controllers have not released the cloud load balancers
Error: deleting EC2 Subnet (...): DependencyViolation
Error: deleting EC2 Internet Gateway (...): DependencyViolation ... has some mapped public address(es)
Error: deleting ACM Certificate (...): ResourceInUseException
Destroy failed with cloud-backed objects still held — releasing again and retrying the destroy ONCE.
Skipping load-balancer release: the cluster is not reachable (no EKS cluster name in outputs).
teardown RunDestroy failed (workflow aws-cleanup.sh is the guarantee): tofu destroy failed: exit status 1
```

The nightly stays green for two reasons: `test/e2e/t2_provision_test.go:601` reports the failure
with `t.Logf`, not `t.Errorf`, and `scripts/e2e/aws-cleanup.sh` then sweeps the account
(`aws cleanup verified complete ... no billable resources remain`). A customer has no sweep: a
destroy of an AWS environment with the ingress and certificate on ends failed, with the load
balancer, VPC, subnets and certificate left behind and billing.

- **Files:** `packages/core/provisioner/destroy_loadbalancers.go` (`releaseCloudLoadBalancers`,
  `stopArgoCDReconciling`, `lbReleaseTimeout`), `packages/core/provisioner/destroy.go`
  (`retryReleaseAndDestroy`).
- **Likely cause, not proven by a run:** the release marks every ArgoCD Application for deletion
  first, and those deletions cascade. On AWS that includes the Application that installs the load
  balancer controller, which is the only thing that can delete the load balancer and clear the
  Ingress's finalizer. The Ingress is then deleted with nothing left to finalize it and stays held
  for the full four minutes. The earlier fix for the same symptom, #3395, covered a Service of type
  LoadBalancer.
- **Proposed change:** release the cloud-backed Services and Ingresses and wait for them to go
  **before** deleting the Applications that carry their controllers (or exclude those controller
  Applications from the first pass). Then make the nightly fail the leg when the product's destroy
  fails on a cloud where it is expected to succeed, so the sweep is a backstop and not the verdict.
- **Verification it needs:** one aws floor dispatch, which is priced spend and the maintainer's.

### 4.2 A deploy whose apps repository cannot be cloned still ends "completed successfully"

Product gap, off the golden path (it needs a rejected repository credential). On 11-15 the runner
logged `Warning: GitOps add-on sync skipped: clone apps repo: authentication failed` and then
`job completed successfully`. The warning goes to the job log only
(`packages/core/provisioner/addon_stage.go:209-211`: the error is printed to stderr and is not added
to `out.Warnings`, unlike the add-on drift entries two lines above it). A user whose repository
token is wrong sees a successful deploy and an apps Application that never syncs. Proposed change:
carry the error as a structured warning on the job result so the console can show it; whether it
should fail the deploy instead is a product decision.

## Run and job reference

| Date | Run | Event | Branch | Conclusion |
|---|---|---|---|---|
| 11-01 | 41297407846 | schedule | main | failure (gcp job 124821086766) |
| 11-08 | 42470800384 | schedule | main | failure (jobs 128700875868 hetzner, 128700875843 aws, 128700875815 gcp, 128701903324 azure) |
| 11-14 | 43584972602 | schedule | main | success |
| 11-15 | 43705941979 | schedule | main | failure (rollup job 132808612204 filed #6715 to #6718) |
| 11-16 | 43855704868 | schedule | main | success |
| 11-17 | 44077358655 | schedule | main | success |
