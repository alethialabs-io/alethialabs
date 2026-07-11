<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# `sandbox` — the per-job isolation runtime (E0)

The seam through which the runner executes a job's **untrusted** portion — customer OpenTofu HCL run via
`tofu`, customer Helm charts applied via `helm`/`kubectl`. Running Alethia's **own** templates in-process is
fine (they're trusted); running **bring-your-own** IaC/Helm that way is not — a malicious Terraform provider,
`external` data source, or Helm hook would inherit the runner's whole environment.

This package is the boundary that makes **managed untrusted BYO execution** safe. The runner calls
`Sandbox.Run` instead of invoking the provisioner directly; the backend decides how much isolation that gets.

## Why a seam, not just "scrub the env"

The load-bearing finding from the E0 red-team: **leaf env-scrubbing is not a boundary.** The untrusted
`tofu`/`helm` child runs as the **same uid in the same PID namespace** as the worker, which holds the full
environment. So the child can `open("/proc/1/environ")` and recover `ALETHIA_RUNNER_TOKEN`, the storage
master key, the bootstrap token — captured at `execve` time, immune to any later `Unsetenv`. Only a real
**uid / pid / net namespace boundary** (a per-job container, or a microVM) contains it. Everything here
follows from that: the container is the boundary, and the secrets it must not see are **removed at the
source** so they aren't in the environment (or the workdir) to begin with.

## The two backends

Both implement `Sandbox` (`sandbox.go`). The single call site (`agent/runner.go` `selectSandbox`) builds the
work **once** as both a closure and a serializable `Stage`, so the two backends converge on identical work.

| Backend | File | Isolation | When |
|---|---|---|---|
| `Passthrough` | `passthrough.go` | none — runs the closure in-process with the full host env | default; **trusted** templates only (today's managed provisioning + self-hosted) |
| `Container` | `container.go` | fresh per-job container: allowlisted env, own PID ns, RO cred mounts, egress gate | **untrusted** BYO on the managed fleet, once enabled (E0 3b) |

`Passthrough` is fail-**open** (it runs), so it is deliberately loud and can be made to **refuse** on any
non-`self` runner via `EnforceManaged` (wired to `ALETHIA_SANDBOX_ENFORCE_MANAGED`) — the config-driven
kill-switch so a mis-configured pool never silently downgrades to no isolation. The refusal is
fail-**closed** against the operator string: only an explicit `operator=self` is lenient, so an
empty/miscased/unknown operator refuses rather than running untrusted tofu in-process. Selection is off
`ALETHIA_SANDBOX_BACKEND`; a container backend that fails to initialize on any non-`self` runner is
**fail-closed** (a refusing `Passthrough`), never a silent fallback.

## The Container backend

A container can't run a Go closure, so the work is **serialized** and the runner **re-execs itself** inside
the container (mirroring the worker re-exec). `Spec.Stage` (`Kind` ∈ `deploy|plan|destroy|chart_scan` +
an opaque JSON `Payload` owned by the agent package) is the contract; the parent writes `stage.json` into the
per-job `WorkDir`, the child (`ALETHIA_RUNNER_EXEC_STAGE=1`, `agent/exec_stage.go`) reconstructs the params
and runs the provisioner behind a `Passthrough` (the child **is** the boundary), and writes `result.json`
back for the parent to read.

What the child is allowed to see (`container.go`):

- **Env allowlist** (`credAllowKeys`) — only the cloud-auth vars the activators set (file paths + non-secret
  ids: `AWS_CONFIG_FILE`/`AWS_PROFILE`, `GOOGLE_APPLICATION_CREDENTIALS`, `ARM_*`/`AZURE_*`,
  `ALIBABA_CLOUD_*`), the token-cloud tokens the tofu provider needs (`HCLOUD_TOKEN`, …), the state-proxy
  auth (`TF_HTTP_*`), the egress proxy vars (`HTTP(S)_PROXY`/`NO_PROXY`), and a minimal toolchain
  (`PATH`/locale). Per-job secrets the child legitimately needs (git token) cross as explicit
  `ALETHIA_STAGE_*` keys. **Everything else is dropped.**
- **`assertNoSecrets` fail-closed guard** — runs on the *final* child env and refuses to start the container
  if any denylisted secret survived (any `ALETHIA_*` except the `ALETHIA_STAGE_*`/exec-stage keys, or any
  static `AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN`). A coding mistake that widens the allowlist is caught
  before untrusted code runs, not after.
- **RO cred-DIR mounts** — the parent activates cloud creds into per-job `MkdirTemp` **directories**; the
  backend RO-mounts the *directory* (not the file) at its identical absolute path, so the parent's 5-minute
  atomic-rename token refresh stays visible to a long `tofu apply` (a per-file mount would pin the stale
  inode).
- **Hardening** — `--rm --init --cap-drop ALL --security-opt no-new-privileges`, pids/memory limits, RW only
  the workdir, and the network policy below.

## What makes the isolation real — removing secrets at the source

The container contains `/proc`, but it can only contain what isn't already handed to it. Three source-drops
(shipped before/with the container) are what let the allowlist above be short and the fleet cloud-init
secret-free:

- **Tofu state via the console HTTP proxy** (not inline storage creds). The project templates use a
  `backend "http"` pointed at `/api/jobs/[id]/state{,/lock}`; auth is a **per-job, key-scoped** HS256 token
  in `TF_HTTP_PASSWORD` (never a file in the workdir). The state key is derived **server-side** from the job
  row (`projects/{project_id}/{environment_id}/tofu.tfstate`), and a `tofu_state_locks` table provides
  fenced locking. No storage master key touches the runner — for project **or** runner-lifecycle state.
- **Per-job cloud-token mint binding.** `/api/runners/{cloud}-token` require the runner to own a live
  (`PROCESSING`) job whose `cloud_identity.provider` matches — a stolen runner token can't mint arbitrary
  clouds' credentials.
- **Per-VM, instance-bound bootstrap tokens.** Each fleet VM gets its own short-TTL token (bound to the VM
  instance id on first redeem), not one shared fleet secret.

Together these **drained the metadata "firehose"**: a Hetzner VM's cloud-init (served by the
`169.254.169.254` metadata service) used to carry the storage master key **and** a shared bootstrap token as
`docker run -e` flags. Both are gone from the cloud-init — which is why egress control (below) closes the
*last* on-box read rather than being the only line of defense.

## Egress (E0 3b) — default-deny netns + domain-allowlist proxy

Even secret-free, an unrestricted child could `curl 169.254.169.254` and read whatever a future cloud-init
carries. So on the managed fleet the child gets **no route of its own**:

- The fleet VM creates a `docker network --internal alethia-egress` (no gateway → no route off the VM), runs
  a **squid forward proxy** on it (allowlists by **CONNECT host** against a `dstdomain` list — no TLS
  interception), and starts the runner on that net with `HTTP(S)_PROXY` set. The untrusted child inherits
  the runner's IMDS-less netns (`ALETHIA_SANDBOX_NETWORK=host`), so **169.254.169.254 is unreachable by
  construction** and only allowlisted domains egress. A `DOCKER-USER` iptables rule dropping the metadata IP
  is a third, redundant belt.
- The backend enforces this with a **fail-closed managed egress gate**: `operator=managed` + a non-`NoEgress`
  stage refuses to run unless `ALETHIA_SANDBOX_EGRESS_ENFORCED=1`. A `chart_scan` stage is exempt because it
  runs with `--network none` (deny-all) and zero secrets.

The nested-podman runtime + this egress net can't be reproduced in CI (userns, `/dev/fuse`, link-local IMDS),
so they are **verified on a real Hetzner VM** — see the 3b canary in the
[managed-provisioning runbook](../../../apps/docs/content/docs/self-hosting/managed-provisioning.mdx).

## What shipped (the dependency chain)

The red-team reshaped E0 into a strict order, each its own PR into `dev`:

| Step | What | PR |
|---|---|---|
| 0 | console authz guards (ownership on runner-facing routes) | #268 |
| 1 | job-bind the cloud-token mint | #269 |
| 2 | console tofu-state proxy — console half / runner half | #270 / #272 |
| 2b | runner-lifecycle state → proxy; **drop `ALETHIA_STORAGE_*` from the fleet** | #274 |
| 0b | per-VM instance-bound bootstrap tokens; **drop the shared bootstrap token** | #279 |
| 3 | the container backend (this package) — re-exec, allowlist, gate | #273 |
| 3b | fleet enablement plumbing (podman toolchain, egress net, config-gated turn-on) — **inert** | #281 |

Steps 2b + 0b are the two halves of the firehose drain. 3b ships inert (`FLEET_SANDBOX_CONTAINER` off → the
cloud-init is byte-identical); turn-on is config-only after the real-VM canary.

## Residuals (labeled honestly)

- **Per-job, short-TTL, job-scoped creds are visible to that job's own code** — the accepted residual (the
  job needs them to provision). What the boundary protects is *cross-tenant* + *fleet-wide* secrets.
- **Receipt signing** stays in the parent and is not on the managed fleet, so managed receipts are unsigned —
  consistent, not a regression. The future hardening is a plan(child)→gate+sign(parent)→apply(child) split.
- **Self-hosted static-AWS creds** would be *denied* by the allowlist — the container backend targets managed
  OIDC; self-hosted uses `Passthrough`, so this only bites if a self-runner is opted into `container`.

## Env reference

| Var | Where | Meaning |
|---|---|---|
| `ALETHIA_SANDBOX_BACKEND` | runner | `container` selects the Container backend; unset = `Passthrough` |
| `ALETHIA_SANDBOX_RUNTIME` | runner | `docker` (local) or `podman` (fleet) |
| `ALETHIA_SANDBOX_IMAGE` | runner | child image (defaults to the runner's own image ref) |
| `ALETHIA_SANDBOX_NETWORK` | runner | child `--network` (`host` on the fleet → inherit the IMDS-less netns) |
| `ALETHIA_SANDBOX_EGRESS_ENFORCED` | runner | confirms egress control — the managed gate requires it (set only after the canary) |
| `ALETHIA_SANDBOX_ENFORCE_MANAGED` | runner | `Passthrough` kill-switch: refuse managed-unsandboxed |
| `FLEET_SANDBOX_CONTAINER` | console | render the 3b cloud-init (egress net + proxy + container backend) |
| `FLEET_SANDBOX_EGRESS_ENFORCED` / `FLEET_SANDBOX_ENFORCE_MANAGED` | console | inject the two runner flags above |
| `FLEET_EGRESS_EXTRA_DOMAINS` / `FLEET_EGRESS_PROXY_IMAGE` | console | extra allowlist domains / the proxy image |

See also: [`verify/`](../verify/README.md) (the plan-JSON policy gate that runs between plan and apply) and
the customer-facing [Security Architecture](../../../apps/docs/content/docs/concepts/security.mdx).
