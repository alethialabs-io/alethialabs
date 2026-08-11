<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# The demo runbook — internal

The script for running the enterprise demo live in front of someone. **Internal**: it carries account
choices, cost figures and the dead-ends to steer around. The customer-facing version — the one you
can send them afterwards — is [`/tutorials/enterprise-demo`](../apps/docs/content/docs/tutorials/enterprise-demo.mdx).

Read both. This page is what you do; that page is what you show.

---

## 0 · The decision you make before anything else

**Which cloud, and how much of the demo.**

| You have | Do this | Cost | Wall clock |
|---|---|---|---|
| 15 minutes, a screen share | **Hetzner, pre-warmed** (§2) | ~€0.02 | 5 min live |
| 40 minutes, they want to watch it build | Hetzner, cold | ~€0.10 | ~35 min |
| They asked specifically about AWS/GCP/Azure | that cloud, **pre-warmed** | $0.45–0.60/hr | 10 min live |
| They asked "does it really do four clouds" | four browser tabs, all pre-warmed (§6) | ~$1.80/hr | 15 min |

**Default to Hetzner, pre-warmed.** It is five to six times cheaper, comes up in ~12 minutes rather
than ~20, and the connector is one paste — which is itself a good moment in the demo.

<!-- Fill these in for your own accounts; they are deliberately not committed. -->

| Cloud | Account / project to use | Region | Identity id |
|---|---|---|---|
| Hetzner | _(a project dedicated to demos — see the warning in §1)_ | `nbg1` | |
| AWS | | `us-east-1` | |
| GCP | | `europe-west3` | |
| Azure | | `germanywestcentral` | |

---

## 1 · Pre-flight, the day before

- [ ] `alethia --version` — and make sure it is a build with `project design apply` in it
      (`alethia project design apply --help` should not error).
- [ ] `alethia whoami` and `alethia org switch` — demo in a **demo org**, not your own.
- [ ] A runner is online: `alethia runner list` shows a recent heartbeat. If not,
      `alethia runner register demo-box` and start it. A "waiting for runner" hang is the single most
      common way this demo dies, and it is invisible until the plan just sits there.
- [ ] Connectors verified: `alethia provider verify hetzner` (and any other cloud you will use).
- [ ] Quotas checked for any managed cloud you will touch. GCP NodePool quota and Azure regional vCPU
      are the two that fail at apply time, minutes in, and cannot be fixed live.
- [ ] The demo repo is reachable: <https://github.com/alethialabs-io/enterprise-demo>.

> ⚠️ **Hetzner tokens are project-scoped and can do anything inside that project.** Use a Hetzner
> project that holds nothing you care about. Do not demo from the project the sandbox box lives in.

---

## 2 · Pre-warming (do this ~40 minutes before)

Run steps 1–4 of the tutorial up to and including the apply, and let the cluster finish. Then in the
demo you run the *interesting* commands against something that already exists.

```bash
alethia project create boutique-demo \
  --region nbg1 --cloud-identity-id <id> \
  --env dev:development:namespace:boutique-dev \
  --env staging:staging:vcluster:boutique-staging

alethia project component add -p boutique-demo --env dev --kind cluster \
  --set cluster_version=1.31 --set node_desired_size=2 --set node_min_size=2 --set node_max_size=3

alethia project component add -p boutique-demo --env dev --kind repositories \
  --set apps_destination_repo=https://github.com/alethialabs-io/enterprise-demo \
  --set apps_path=overlays/dev

alethia project component add -p boutique-demo --env staging --kind repositories \
  --set apps_destination_repo=https://github.com/alethialabs-io/enterprise-demo \
  --set apps_path=overlays/staging

alethia project plan  --project-id boutique-demo --wait
alethia project apply --project-id boutique-demo --plan-job-id <id> --wait
```

Then leave two terminals and one browser tab open:

1. a shell in the project, `alethia cluster get boutique-demo` already run
2. a shell with a kubeconfig loaded
3. the ArgoCD UI, logged in

---

## 3 · The live script

### Beat 1 — "connecting a cloud takes one command, and stores no key" (2 min)

```bash
alethia connector hetzner
```

Say while it runs: every other cloud is **keyless** — an AWS role, GCP Workload Identity Federation,
an Azure federated credential. Hetzner is the exception and the exception is Hetzner's: it publishes no
OIDC provider, so a token is the only mechanism it offers. **Do not gloss this.** Being precise about
the one place you store a secret is what makes the other four credible.

### Beat 2 — "the shape is one command" (2 min)

Show the `project create` line from §2 on screen. Point at the two `--env` values and read the
placements out loud: `namespace`, `vcluster`.

**Pause here.** This is the idea the whole demo exists to land: two environments, one Fabric.

### Beat 3 — "two tiers, one repo, different overlays" (2 min)

```bash
alethia project component list -p boutique-demo --env dev
alethia project component list -p boutique-demo --env staging
```

Same repository, different `apps_path`. If they ask why that matters: because it is how a real team
runs dev and staging from one source of truth, and because the alternative — a second cluster per
tier — is what they are paying for today.

### Beat 4 — the gate (3 min) ★

```bash
alethia project plan --project-id boutique-demo --wait
```

The plan stops at the **verify gate**. Show the verdict. Then say the part that matters: the receipt
is **signed**, so it is evidence, not a log line — you can hand it to an auditor.

If you have a prepared failing example, this is where it goes. A refused apply is more convincing
than a successful one.

### Beat 5 — "it is running" (3 min)

```bash
kubectl get pods -n boutique-dev
kubectl get pods -n boutique-staging
```

Then ArgoCD: two Applications, `app-boutique-demo-boutique-dev` and
`app-boutique-demo-boutique-staging`, each pinned to its own AppProject
(`tenant-boutique-demo-boutique-dev`, `tenant-boutique-demo-boutique-staging`). The AppProject is what
stops one tier reaching into the other.

### Beat 6 — the close (2 min) ★★

```bash
alethia cluster list
```

**One cluster.** Two environments, delivered independently, isolated from each other — and one
infrastructure bill. Then add a third in front of them:

```bash
alethia project env add qa -p boutique-demo --stage development \
  --placement-mode namespace --namespace boutique-qa
```

No new cluster. This is the moment to stop talking.

### Beat 7 — if they ask "can we put this in CI?" (1 min)

```bash
alethia config export -p boutique-demo --out boutique.json
alethia project design apply -p boutique-demo -f boutique.json --dry-run
```

The whole environment as a document, and a plan that writes nothing. Every command in this demo is a
CLI command, so all of it is scriptable.

---

## 4 · Abort drill

**If the plan hangs:** it is the runner. `alethia runner list` — no recent heartbeat means nothing is
claiming the job. Say "the runner that executes this is one I'm running myself, and it has dropped"
and move to the pre-warmed environment. Do not debug live.

**If the apply fails:** show the failure. `alethia jobs logs <id> --follow` names the stage. A visible,
specific failure with a signed record of what was attempted is a better demo than a hidden one — the
product's whole claim is that failures are recorded rather than hidden.

**If the cloud refuses on quota:** say so plainly, it is their cloud's limit and not yours, and switch
to Hetzner.

**Never** run `alethia ops …` in front of anyone. Break-glass is not a demo.

---

## 5 · Teardown — same day, every time

```bash
alethia project destroy --project-id boutique-demo --wait
alethia cluster list
```

Then check the cloud console. The per-cloud teardown checks are in the tutorial's cloud pages; the
short version:

| Cloud | What survives a partial teardown |
|---|---|
| Hetzner | volumes, load balancers |
| AWS | NAT gateways, VPC endpoints, load balancers — and a leftover VPC costs you one of five per region |
| GCP | reserved static addresses, forwarding rules |
| Azure | the auto-generated `MC_…` resource group — public IPs and managed disks hide there |

Also release the sandbox box if you used it: `pnpm env:down`, and `pnpm env:reap --now` when finished
for the day. The box bills for every hour it **exists** — €69.49/month standing versus €0.72 reaped.

---

## 6 · The four-cloud version

Only when someone explicitly doubts the multi-cloud claim. Pre-warm all four, one browser tab each,
and show `alethia cluster list` across them. ~$1.80/hour combined, so book the time and tear down the
moment you are done.

The CI proof of the same thing is the `E2E_FABRIC_DEMO` nightly leg (#845). If you want it as
repeatable evidence rather than a live demo:

```bash
gh variable set E2E_FABRIC_DEMO --body 1
gh workflow run e2e-nightly.yml -r main -f provider=aws     # then gcp, azure, hetzner — ONE AT A TIME
gh variable delete E2E_FABRIC_DEMO                          # ← do not skip this
```

Roughly **$6 for four proofs**. Deleting the variable afterwards is not optional: while it is
non-empty, every leg's job cap rises to 210 minutes on **all five clouds**, and on the nightly cron
that is about **$180/month**. Leave `E2E_NAMESPACE_TENANT` and `E2E_VCLUSTER` off on the same night —
their budgets sum into one context and `cmd/t2budget` will refuse the run.

Proof bundles land in `demos/proofs/<cloud>/<stamp>/`. Commit them; the parity board flips on a real
artifact, never on a green harness.

---

## 7 · Known dead-ends — do not walk into these

- **`alethia runner deploy` is AWS-only.** `infra/templates/runner/` holds one cloud. Everywhere else
  it is `alethia runner register` and a runner you operate. Do not promise `deploy` on GCP.
- **Add-on marketplace *browsing* is console-only.** The CLI enables an add-on by catalog id
  (`alethia addon enable loki`), and `alethia addon list` shows what is installed — but there is no
  `addon search`. Have the console open if you want to browse.
- **BYO chart and BYO IaC are behind instance flags** (`ALETHIA_BYO_HELM_ENABLED`,
  `ALETHIA_BYO_IAC_ENABLED`). Without them the commands return 501 naming the variable. Check before
  you promise the BYO story.
- **BYO IaC will not attach to an environment that already has template state** — a 409. It is a
  separate demo on a fresh environment, not an add-on to this one.
- **`demos/DEMO-READINESS.md` is a historical ledger, not a status page.** It tracks #294–#348 against
  a HEAD past #2320. Do not quote it.
- **Keep `Formula/grape.rb` off the screen.** Stale cruft from the pre-rename era, with a
  "Proprietary" license line in it.
