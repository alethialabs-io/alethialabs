<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Cloud preflight — what is connected, and what still needs connecting

Taken **2026-08-24**, from the maintainer's Mac, against the five accounts the MVP programme
targets. Every line below is a live read, not a restatement of what a board says.

The question this answers is the one that had never been asked directly: **for each cloud, can we
provision today, and if not, what exactly is missing?** `PROGRAMME.md` records that 0 of 25 proof
cells are proven; this file records *why*, separated into what is our debt and what is an account
that has not been set up.

> Read with `PROGRAMME.md` (what is proven) and
> `docs/testing/maintainer-unblock-checklist.md` (which gate variables are set). This file is about
> the **accounts**, which neither of those can see.

---

## Verdict table

| cloud | authenticates | can provision today | what is missing |
|---|:---:|:---:|---|
| **aws** | ✅ `alethia-admin` (AdministratorAccess) | ✅ **yes — proven this session** | nothing |
| **hetzner** | ✅ `alethia-infra-tests` | ⚠️ reaches the apply, image build times out | a product fix (#2458), not an account change |
| **azure** | ✅ Azure for Students | ⚠️ untested — nothing structurally blocks it | a real run to settle the credit question |
| **gcp** | ✅ `borislav1207@gmail.com` | ❌ **no** | **an open billing account** |
| **alibaba** | ✅ RAM user `test` (AdministratorAccess) | ❌ **no** | the `AliyunCSDefaultRole` service-linked role |

Two of five are blocked on something only the account owner can do, and neither blocker is
described anywhere in the tree. Both are cheap to clear.

---

## aws — ready, and exercised

- Identity `arn:aws:iam::270587882865:user/alethia-admin`, **AdministratorAccess**.
- `us-east-1` quota: **16** Standard On-Demand vCPU, 5 Elastic IPs. The floor shape
  (`t3.large` × 1 = 2 vCPU) and the heavy full-bar profile both fit comfortably.
- A real EKS cluster was provisioned from this Mac during this session, so this is a
  demonstrated capability rather than an inference.

**Orphans found and cleared.** `alethia:project-id`-tagged resources from ~20 prior runs were
standing in `us-east-1`. Almost all of it was harmless — 36 KMS keys, every one already
`PendingDeletion` and therefore self-healing, plus free IAM policies and log groups. Two things
were not harmless, and both are now gone:

- a **network load balancer** (`k8s-ingressn-addoning-01a2778917`) with two target groups, created
  by ingress-nginx during run `31929564177` and billing continuously since **2026-08-16**;
- the **VPC** for that run, held open by two cluster-created security groups.

Neither was reachable by the sweeper. See *The blind spot* below — it is a product defect, fixed
in the same session.

## hetzner — the account is clean; the image build is not

- Context `alethia-infra-tests` authenticates and the project is **completely empty** — an ideal
  e2e target, with no shared-prod blast radius.
- A floor run reached a real `tofu apply` and failed inside it:

  ```
  Error: Upload failed
    with imager_image.amd64[0], on image.tf line 60
  failed to create snapshot: context deadline exceeded: remaining running actions: [651005379737863]
  ```

  The Talos image build (`hcloud-talos/imager` v1.0.18, configured as a bare `provider "imager" {}`
  with no timeout) exceeded its deadline while Hetzner was still snapshotting. Filed as **#2458**.

- **This is the first time that code path has ever executed.** The nightly's hetzner leg
  green-skips for want of `HCLOUD_TOKEN`, so a failure here was never going to be caught by CI —
  which is the concrete cost of the unwired gate in #1579/#1720, and a better argument for wiring
  it than "the table has a gap".

- The `amd64` in that error is **correct, not a bug**: `variables.tf` defaults both node types to
  `cpx22` because "cax11 (ARM) is capacity-unreliable and cpx11 is retired". The comment in
  `e2e-nightly.yml` describing the run as "cheapest cax11 ARM" is stale.

- **A second leak class.** The failed build left a server, a snapshot and an SSH key named
  `hcloud-upload-image-<hex>`, created by the imager provider's own upload helper. The snapshot
  carries `cluster=<name>` and is swept; the **server and SSH key carry no label at all**, so
  `hcloud-cleanup.sh`'s selector cannot reach them. They were removed by hand here. This is the
  same shape as the AWS blind spot and deserves the same treatment — filed separately, because the
  safe scoping is not obvious and guessing at it would risk another run's upload server.

## azure — nothing structurally blocks it

Worth stating plainly, because the assumption going in was that a student subscription would be
too small, and **the numbers do not support that**:

- Subscription `32f3d6ca…` "Azure for Students", tenant `2b473302…`, state **Enabled**.
- `germanywestcentral` regional quota: **10 total vCPU, 0 in use.**
- Floor (`Standard_D2s_v3` × 1) is 2 vCPU. The heavy full-bar profile
  (`Standard_E2s_v3` × 3) is 6 vCPU. Both fit, even allowing for the AKS system pool.
- `az vm list-skus` reports **no restrictions** on either family for this subscription.
- `Microsoft.ContainerService`, `.ContainerRegistry`, `.KeyVault` and `.DBforMySQL` are all
  **Registered**. A `alethia-e2e-nightly` consumption budget of 100 exists.
- No AKS clusters and no stray e2e resource groups are standing.

The open question is the **credit balance**, not the quota, and no read available here settles it.
The cheap way to settle it is one floor dispatch.

## gcp — blocked, and this is the real reason the cell has never run

```
$ gcloud container clusters list --project=itgix-adp
ERROR: code=403 — This API method requires billing to be enabled.

$ gcloud beta billing accounts describe 012128-F87F79-AAE313
displayName: My Billing Account
open: false          ← the account is CLOSED
```

`gcloud beta billing projects describe itgix-adp` reports `billingEnabled: true`, so the project
*is* linked — but it is linked to a **closed** billing account. Every billable API therefore 403s
while the cheap metadata reads that most checks use keep succeeding, which is precisely how this
stayed invisible: `compute.googleapis.com` and `container.googleapis.com` are both enabled, and
listing networks works.

**Nothing in the repo can fix this.** Until `itgix-adp` is attached to an open billing account (or
the e2e stack is pointed at a different project), `gcp/floor` cannot run, and #2258 / #2099 have no
achievable fix. It also means the #1871 billing-budget work cannot be validated here.

**Action: attach an open billing account to `itgix-adp`, or nominate a different GCP project.**

## alibaba — one missing service-linked role

```
$ aliyun cs GET /clusters --region eu-central-1
EntityNotExist.Role: The role not exists: acs:ram::5767983785483306:role/aliyuncsdefaultrole
```

`AliyunCSDefaultRole` is the service-linked role Container Service requires before ACK will serve
any request — including a read. It is created once per account, normally by visiting the ACK
console's authorization prompt. Until it exists, **no ACK call succeeds**, so an alibaba floor run
cannot get off the ground regardless of credentials or spend.

The RAM user itself is fine: `AdministratorAccess` + `PowerUserAccess`. So this is a one-time
account setup step, not a permissions problem.

**Action: create `AliyunCSDefaultRole` once (ACK console authorization, or
`ram:CreateServiceLinkedRole`).**

Also standing, and unrelated to the above: `infra/templates/project/alibaba/modules/cr` creates
`alicloud_cr_ee_instance` with `payment_type = "Subscription"` — the only prepaid resource in the
repo, and the reason the weekly full-bar cron was removed. Any alibaba full bar buys a month.

---

## The blind spot both leaks share

The AWS sweeper scopes by `alethia:project-id`, the tag tofu stamps. Resources the **cluster**
creates — the load balancer ingress-nginx asks for, the security groups the CCM and the Load
Balancer Controller create, Karpenter's instances — never carry it. `discover_cluster()` exists to
bridge that, resolving the EKS name so cluster-scoped sweeps can run.

It resolved that name from the tagged EKS ARN, then fell back to EC2 tag keys. Its own comment
promised a second fallback over load-balancer tag values, and **the code never had one**. So in the
one state that matters — cluster deleted, instances deleted, load balancer still alive, which is
exactly how a hard-killed run ends — `CLUSTER` stayed empty and every cluster-scoped sweep became a
silent no-op.

The failure was worse than an unswept resource, because `alive_lbs` in `verify_swept` is
CLUSTER-scoped too: the sweep could not **see** the leak it had failed to remove, and **exited
green**. Run `31929564177`'s NLB billed for eight days behind a passing check.

The security groups compounded it. A VPC cannot be deleted while a non-default group remains, so
`delete-vpc` failed on every retry forever, `verify_swept` failed forever, and the nightly
preflight burned its whole budget re-walking the same undeletable orphan — which is why the run
reports two further orphans (`31992982561-1`, `aws07232004`) as *never reached*. The queue in front
of them never drained.

Both are fixed, with the first self-test this script has ever had, asserting both directions so a
wildcard could not pass for a fallback. Verified against the real orphan: the sweep now resolves
`eks-ue1-31929564177-1-alethia-nl` from the load balancer's own tag, deletes the NLB, both target
groups, both security groups and the VPC, and `verify_swept` passes for the first time.

**The generalisable lesson:** a sweeper scoped to the tags *our* IaC writes is structurally blind to
everything the cluster creates on our behalf, and a verifier that shares the sweeper's scope cannot
catch it. Hetzner has the same shape, in a different provider's helper.

---

## What a maintainer should do with this

Ranked by how much they unblock per minute spent:

1. **Attach an open GCP billing account to `itgix-adp`** — unblocks a whole cloud and two issues.
2. **Create `AliyunCSDefaultRole`** — one click, unblocks a whole cloud.
3. **Set the `HCLOUD_TOKEN` repo secret** — stops the hetzner leg green-skipping, so failures like
   #2458 are caught by CI instead of by hand.
4. **Run the four e2e federation applies** so the OIDC trust widening is authoritative rather than
   hand-applied (see the issue filed alongside this document).
5. **Delegate a real DNS zone (#1773)** — the single ceiling failing the CLI bar on every cloud.
