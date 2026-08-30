<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# The demo runbook — internal

The script for running the enterprise demo live in front of someone. **Internal**: it carries account
choices, cost figures and the dead-ends to steer around. The customer-facing version — the one you
can send them afterwards — is [`/tutorials/enterprise-demo`](../apps/docs/content/docs/tutorials/enterprise-demo.mdx).

Read both. This page is what you do; that page is what you show.

> Every command here is copied from the CLI's own flag registrations. If one fails, the binary is
> older than this page — check `alethia --version` before debugging anything else.

---

## 0 · The decision you make before anything else

**Which cloud, and how much of the demo.**

| You have | Do this | Cost | Wall clock |
|---|---|---|---|
| 15 minutes, a screen share | **Hetzner, pre-warmed** (§2) | ~€0.02 | 5 min live |
| 40 minutes, they want to watch it build | Hetzner, cold | ~€0.10 | ~35 min |
| They asked specifically about AWS/GCP/Azure | that cloud, **pre-warmed** | $0.45–0.60/hr | 10 min |
| They asked "does it really do four clouds" | four browser tabs, all pre-warmed (§7) | ~$1.80/hr | 15 min |

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

## 1 · The topology, and the one rule that makes it work

The demo builds **five environments at four isolation levels**:

| Environment | Stage | Placement | Namespace | What it shows |
|---|---|---|---|---|
| `prod` | production | `dedicated` | — | Owns a Fabric. Its own cluster. |
| `staging` | staging | `vcluster` | `boutique-staging` | Own Kubernetes API server, shared nodes. |
| `dev-1` | development | `namespace` | `boutique-dev-1` | A namespace. Cheapest rung. |
| `dev-2` | development | `namespace` | `boutique-dev-2` | |
| `dev-3` | development | `namespace` | `boutique-dev-3` | |

**The rule: only a `dedicated` environment brings a cluster into being.** A `namespace` or `vcluster`
environment is *placed onto* a Fabric whose cluster already exists — the provisioner fails closed
otherwise. So the order is always:

> create with a dedicated env → `plan` → `apply` → **then** add the shared tiers.

You can seed the whole matrix at `project create` time (every shared tier lands on the default
dedicated env's Fabric), but the cluster still only exists after the apply.

**Two shapes.** *One Fabric* — `prod` owns the only cluster and everything rides on it: cheapest,
fastest, and the strongest "one bill" line, but do not then claim prod is isolated. *Two Fabrics* —
a second dedicated env owns a second cluster carrying the shared tiers, leaving `prod` genuinely
alone. Twice the cost; the honest enterprise shape. §3 builds the second and tells you where to stop
if you want the first.

---

## 2 · Pre-flight, the day before

- [ ] `alethia --version` — and make sure it is a build with `project design apply` in it
      (`alethia project design apply --help` should not error).
- [ ] `alethia whoami` and `alethia org switch` — demo in a **demo org**, not your own.
- [ ] A runner is online: `alethia runner list` shows a recent heartbeat. If not,
      `alethia runner register demo-box` and start it. A "waiting for runner" hang is the single most
      common way this demo dies, and it is invisible until the plan just sits there.
- [ ] **A runner is online _and can mint credentials for your cloud_** — these are different checks,
      and only the second one matters. A runner whose operator is `self` has no ambient cloud
      credentials in production and cannot federate into **AWS or GCP**; the job fails with an error
      naming *EC2 IMDS*, which has nothing to do with the cause (#3348). **Azure, Alibaba and the
      token clouds (Hetzner, DigitalOcean, Civo) are unaffected** — they have no operator gate.
      Prove it, do not assume it: queue a plan on a throwaway project for the cloud you will demo and
      confirm the log says *Activating keyless …* rather than *Assuming role …*. A plan provisions
      nothing, so this costs nothing.
- [ ] Connectors verified: `alethia provider verify hetzner` (and any other cloud you will use).
- [ ] Quotas checked for any managed cloud you will touch. GCP NodePool quota and Azure regional vCPU
      are the two that fail at apply time, minutes in, and cannot be fixed live.
- [ ] The demo repo is reachable: <https://github.com/alethialabs-io/enterprise-demo>.

> ⚠️ **Hetzner tokens are project-scoped and can do anything inside that project.** Use a Hetzner
> project that holds nothing you care about. Do not demo from the project the sandbox box lives in.

---

## 3 · Pre-warming (do this ~40 minutes before)

Run this to a finished cluster, so in the demo you run the *interesting* commands against something
that already exists.

```bash
# 1 · The project, with prod owning the Fabric it will provision.
alethia project create boutique-demo \
  --region nbg1 --cloud-identity-id <id> \
  --env prod:production:dedicated

# 2 · The cluster is a property of the FABRIC, so it is configured on its owner.
# `cluster_version` is a STRING: unquoted, `--set` coerces 1.31 to a number and the server 400s.
alethia project component add --project boutique-demo --env prod --kind cluster \
  --set 'cluster_version="1.31"' \
  --set node_desired_size=3 --set node_min_size=3 --set node_max_size=4

alethia project component add --project boutique-demo --env prod --kind repositories \
  --set apps_destination_repo=https://github.com/alethialabs-io/enterprise-demo \
  --set apps_path=overlays/prod

# 3 · Provision it. The shared tiers cannot be placed until this cluster exists.
#     --project-id wants the UUID, not the name: `alethia project list -o json` has it.
#     Pass --runner-id too, or the command prompts and dies under --no-input.
alethia project plan  --project-id <uuid> --runner-id <uuid> --wait
alethia project apply --project-id <uuid> --plan-job-id <id> --wait
```

Then add the tiers that cost nothing:

```bash
alethia project env add staging --project boutique-demo --stage staging \
  --placement-mode vcluster --fabric prod --namespace boutique-staging

for n in 1 2 3; do
  alethia project env add "dev-$n" --project boutique-demo --stage development \
    --placement-mode namespace --fabric prod --namespace "boutique-dev-$n"
done

alethia project component add --project boutique-demo --env staging --kind repositories \
  --set apps_destination_repo=https://github.com/alethialabs-io/enterprise-demo \
  --set apps_path=overlays/staging

for n in 1 2 3; do
  alethia project component add --project boutique-demo --env "dev-$n" --kind repositories \
    --set apps_destination_repo=https://github.com/alethialabs-io/enterprise-demo \
    --set apps_path="overlays/dev-$n"
done

alethia project plan  --project-id <uuid> --runner-id <uuid> --wait
alethia project apply --project-id <uuid> --plan-job-id <id> --wait
```

**For the two-Fabric shape**, add a second dedicated env before the tiers and point them at it:

```bash
alethia project env add platform --project boutique-demo --stage staging --placement-mode dedicated
# …configure + apply as in step 2/3 above, then use `--fabric platform` on every tier.
```

Leave two terminals and one browser tab open:

1. a shell in the project, `alethia cluster get boutique-demo` already run
2. a shell with a kubeconfig loaded
3. the ArgoCD UI, logged in

---

## 4 · The live script

### Beat 1 — "connecting a cloud takes one command, and stores no key" (2 min)

```bash
alethia connector hetzner
```

Say while it runs: every other cloud is **keyless** — an AWS role, GCP Workload Identity Federation,
an Azure federated credential. Hetzner is the exception and the exception is Hetzner's: it publishes no
OIDC provider, so a token is the only mechanism it offers. **Do not gloss this.** Being precise about
the one place you store a secret is what makes the other four credible.

### Beat 2 — "the shape is one command" (2 min)

Show the `project create` and `project env add` lines from §3 on screen. Read the placements out
loud: `dedicated`, `vcluster`, `namespace`, `namespace`, `namespace`.

**Pause here.** This is the idea the whole demo exists to land: **the isolation level is a placement
decision, not a procurement decision.** Every one of those tiers except the first cost zero new
infrastructure.

### Beat 3 — "five tiers, one repo, different overlays" (2 min)

```bash
alethia project env list --project boutique-demo
alethia project component list --project boutique-demo --env staging
alethia project component list --project boutique-demo --env dev-1
```

Same repository, different `apps_path`. If they ask why that matters: because it is how a real team
runs its tiers from one source of truth, and because the alternative — a cluster per tier — is what
they are paying for today.

### Beat 4 — the gate (3 min) ★

```bash
alethia project plan --project-id <uuid> --runner-id <uuid> --wait
```

The plan stops at the **verify gate**. Show the verdict. Then say the part that matters: the receipt
is **signed**, so it is evidence, not a log line — you can hand it to an auditor.

The prepared failing example goes here — see [`elench-prompts.md`](./elench-prompts.md). A refused
apply is more convincing than a successful one.

### Beat 5 — "it is running" (3 min)

```bash
kubectl get pods -n boutique-staging
kubectl get pods -n boutique-dev-1
```

Then ArgoCD: one Application per placement, `app-boutique-demo-<namespace>`, each pinned to its own
AppProject `tenant-boutique-demo-<namespace>`. The AppProject is what stops one tier reaching into
another.

> Those names are what `test/e2e/t2_fabric_demo.go` asserts. If this page and that test disagree, the
> test is right.

### Beat 6 — the close (2 min) ★★

```bash
alethia cluster list
```

**One cluster.** (Or two, in the two-Fabric shape — say which, and why.) Five environments, delivered
independently, isolated from each other, and one infrastructure bill. Then add a sixth in front of
them:

```bash
alethia project env add qa --project boutique-demo --stage development \
  --placement-mode namespace --fabric prod --namespace boutique-qa
```

No new cluster. This is the moment to stop talking.

### Beat 7 — if they ask "can we put this in CI?" (1 min)

```bash
alethia config export boutique-demo --out boutique.json
alethia project design apply -p boutique-demo -f boutique.json --dry-run
```

The whole environment as a document, and a plan that writes nothing. Every command in this demo is a
CLI command, so all of it is scriptable.

> `config export` takes the project as a **positional argument** — it has no `-p`. `project design`
> does have `-p`; `project env` and `project component` do **not**, so use `--project` there.

---

## 5 · Abort drill

**If the plan hangs:** it is the runner. `alethia runner list` — no recent heartbeat means nothing is
claiming the job. Say "the runner that executes this is one I'm running myself, and it has dropped"
and move to the pre-warmed environment. Do not debug live.

**If the apply fails:** show the failure. `alethia jobs logs <id> --follow` names the stage. A visible,
specific failure with a signed record of what was attempted is a better demo than a hidden one — the
product's whole claim is that failures are recorded rather than hidden.

**If a shared tier refuses to deploy:** it is almost always the Fabric — the tier was placed onto one
whose cluster is not provisioned. `alethia project env list --project boutique-demo` shows the
placements. Fall back to Beat 5 on a tier that is up.

**If the cloud refuses on quota:** say so plainly, it is their cloud's limit and not yours, and switch
to Hetzner.

**Never** run `alethia ops …` in front of anyone. Break-glass is not a demo.

---

## 6 · Teardown — same day, every time

```bash
alethia project destroy --project-id <uuid> --runner-id <uuid> --wait --yes
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

## 7 · The four-cloud version

Only when someone explicitly doubts the multi-cloud claim. Pre-warm all four, one browser tab each,
and show `alethia cluster list` across them. ~$1.80/hour combined, so book the time and tear down the
moment you are done.

The CI proof of the same thing is the `E2E_FABRIC_DEMO` nightly leg (#845). If you want it as
repeatable evidence rather than a live demo:

```bash
gh variable set E2E_FABRIC_DEMO --body 1
gh workflow run e2e-nightly.yml --ref dev -f provider=aws   # then gcp, azure, hetzner — ONE AT A TIME
gh variable delete E2E_FABRIC_DEMO                          # ← do not skip this
```

**The ref must be `dev`.** A dispatch declares the `e2e-dev` environment, and that environment's
deployment-branch policy is a single custom policy, `dev` — any other ref is refused GitHub-side
before the job starts.

Roughly **$6 for four proofs**. Deleting the variable afterwards is not optional: while it is
non-empty, every leg's job cap rises to 210 minutes on **all five clouds**, and on the nightly cron
that is about **$180/month**. Leave `E2E_NAMESPACE_TENANT` and `E2E_VCLUSTER` off on the same night —
their budgets sum into one context and `cmd/t2budget` will refuse the run.

Proof bundles land in `demos/proofs/<cloud>/<stamp>/`. Commit them; the parity board flips on a real
artifact, never on a green harness.

---

## 8 · Known dead-ends — do not walk into these

- **`--set cluster_version=1.31` is refused.** `--set` coerces anything that parses as JSON, so
  `1.31` arrives as a *number* and the server wants a string: *"Invalid value for cluster_version:
  expected string, received number"*. Quote it as JSON — `--set 'cluster_version="1.31"'`. The same
  trap waits on any string field whose value looks numeric.
- **`--project-id` takes the project's UUID, not its name.** `alethia project list -o json` has it.
- **`plan`/`apply`/`destroy` prompt for a runner** when `--runner-id` is omitted, so under `--no-input`
  they die with *"interactive input required"* — a message that reads like it is complaining about the
  project. `destroy` additionally needs `--yes`.
- **A matrix with no `dedicated` environment is refused at creation.** Nothing in it would ever
  provision a cluster. If you want one cluster carrying everything, make one env `dedicated` and place
  the rest onto its Fabric — that is the demo, not a workaround.
- **`-p` is not a shorthand everywhere.** `project env` and `project component` register `--project`
  with no shorthand; `project design`, `addon`, `chart`, `iac`, `drift`, `cost`, `staged`,
  `protection` and `promotion` do have `-p`. `config export` takes a positional project.
- **`alethia runner deploy` is AWS-only.** `infra/templates/runner/` holds one cloud. Everywhere else
  it is `alethia runner register` and a runner you operate. Do not promise `deploy` on GCP.
- **Add-on marketplace *browsing* is console-only.** The CLI enables an add-on by catalog id
  (`alethia addon enable loki`), and `alethia addon list` shows what is installed — but there is no
  `addon search`. Have the console open if you want to browse.
- **A vcluster is a control-plane boundary, not a hard workload boundary.** Its pods schedule on the
  host's nodes. Say this before they ask; it is in `packages/core/provisioner/vcluster.go` and getting
  it right is what makes the rest of the isolation story credible.
- **BYO chart and BYO IaC are behind instance flags** (`ALETHIA_BYO_HELM_ENABLED`,
  `ALETHIA_BYO_IAC_ENABLED`). Without them the commands return 501 naming the variable. Check before
  you promise the BYO story.
- **BYO IaC will not attach to an environment that already has template state** — a 409. It is a
  separate demo on a fresh environment, not an add-on to this one.
- **`demos/DEMO-READINESS.md` is a historical ledger, not a status page.** It tracks #294–#348 against
  a HEAD past #2320. Do not quote it.
- **Keep `Formula/grape.rb` off the screen.** Stale cruft from the pre-rename era, with a
  "Proprietary" license line in it.
