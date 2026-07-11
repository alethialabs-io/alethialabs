# CLI-free single-image runner — adversarial red-team

> Companion to [`cli-free-single-image.md`](./cli-free-single-image.md). Three independent adversarial
> reviewers (correctness · security · operability) were each told to **refute** the design and verify
> every attack against code. Findings below are their words, consolidated, deduped, ranked, each with a
> CONFIRMED (proven against code) or PLAUSIBLE (needs a real run) verdict. §"Verdict on the design"
> and the decision matrix at the end are the synthesis.

## Severity-ranked findings

### 🔴 R1 — Admin kubeconfig lands in **plaintext in the console Postgres**, not just encrypted S3 state — CONFIRMED (High) — *and it's a pre-existing bug*
`ConfigureKubeconfig`'s design (add an Azure `kube_config_raw` root output) would write the **long-lived
AKS cluster-admin client cert** into `jobs.execution_metadata->'outputs'` in the console DB. The runner
ships **every** tofu output into job metadata (`runner.go:539-555`); `TofuCLI.Output` unmarshals all
outputs regardless of the `sensitive` flag (`tofu.go:132-148`); the console persists it verbatim as JSONB
(`api/jobs/[id]/status/route.ts:56`). `sensitive = true` masks **nothing** here.

**This already happens today for Alibaba and Hetzner** — their `kubeconfig` outputs (both `sensitive`)
already flow into `execution_metadata`. So there is a **current** admin-cert-in-DB exposure, reachable by
DB backups/replicas and **support staff reading jobs cross-tenant** at admin.alethialabs.io
(`[[prod-support-golive]]`). The design would extend it to Azure and endorse it as the "recommended shape."
**Mitigation (do regardless of this project):** strip known sensitive kubeconfig keys from
`result.Outputs` before `UpdateJobStatus` (`runner.go:539`); have `ConfigureKubeconfig` read
`kube_config_raw` without surfacing it as a root output. This retroactively covers Alibaba/Hetzner.

### 🔴 R2 — GCP egress endpoints in the design are WRONG; the token exchange the doc claims allowlist-compat with is a different host — CONFIRMED (High)
The WIF config is a **service-account-impersonation** `external_account` (`session/gcp.ts:37-38`,
`connections.ts:422-427` requires `service_account_impersonation_url`). `x/oauth2/google` on it exchanges
at **`sts.googleapis.com`** then **`iamcredentials.googleapis.com`** `generateAccessToken` — **never
`oauth2.googleapis.com`** (that's the JSON-key flow, which this explicitly is not). The design's §5
allowlist lists the wrong host, so under the future default-deny egress (E0 3b) GKE token-minting would be
blocked → GKE provisioning dead. **Mitigation:** allowlist `sts.googleapis.com` +
`iamcredentials.googleapis.com` (+ GKE API host); drop `oauth2.googleapis.com`.

### 🔴 R3 — Single image **regresses per-VM cold-start**; the "smaller" claim conflates registry storage with per-VM footprint — CONFIRMED (High)
Fleet VMs are **ephemeral** (`hcloud.ts:130` create/destroy; cloud-init cold `docker run ${image}` every
scale-up). Today an AWS pool VM pulls `runner-base` + aws-cli + **one** provider cache
(`Dockerfile.aws:26` inits only `aws`). The single image puts **all five** clouds' provider caches on
**every** VM (~500 MB compressed of never-used `google`/`azurerm`/`alicloud`/`hcloud`/`talos` on an
AWS-only pool), paid on every burst scale-up exactly when the scaler needs capacity fast. §3.1's "far
smaller than the sum of four images" is a *registry-storage* argument, irrelevant to a VM that only needed
one. **Mitigation:** keep lean per-cloud images for the fleet and use one image only for the co-located
box + self-host; **or** bake a Hetzner snapshot with the image pre-pulled to amortize the pull.

### 🟠 R4 — Native arm64 `tofu init` of all five templates is UNPROVEN and is the make-or-break gate — CONFIRMED-risk (High sev / Med conf)
The no-QEMU rule exists because emulated `tofu init` crashes (`Dockerfile.base:14`). The current full
`runner` deliberately inits **only 3 of 5** (`Dockerfile:42` `for d in aws azure gcp`); alibaba/hetzner
templates are copied but init at **job time**, so **build-time arm64 init of the hetzner/alibaba provider
sets has never run in this pipeline**. Hetzner pulls niche community providers — `hcloud-talos/imager`,
`siderolabs/talos`, `alekc/kubectl` (`hetzner/main.tf:23-25,35,49`) — whose `linux_arm64` availability is
unverified; a missing arm64 plugin **fails the arm64 build outright** (half-green failure). §8's "CI inits
all five natively" is treated as a formality but is the highest-risk unknown. **Mitigation:** prove the
arm64 five-template init in CI *before* committing to the collapse.

### 🟠 R5 — Long-lived, non-rotatable cluster-admin certs endorsed as the default — CONFIRMED (Med)
§3.2/§11 score "certs long-lived" as a **pro**. Adversarially it is the liability: an AKS/ACK/Talos client
cert **cannot be revoked without rotating the cluster CA** (rebuild-level surgery). A leaked cert (R1's DB
copy, state, or a sandbox exfil) = **permanent cluster-admin for the cluster's lifetime**. The status-quo
AWS ~15-min / GCP ~1-h tokens self-expire, bounding a leak to minutes. This trades a decaying credential
for a permanent one — must be stated as a con, not scored as a refresh advantage. **Mitigation:** prefer
short-lived minted tokens (AWS/GCP) universally; for Azure, use `azidentity` AAD (short-lived) rather than
the admin cert.

### 🟠 R6 — Runner-as-minter is a self-refreshing admin oracle in the sandbox; minted tokens are NOT cluster-scoped — PLAUSIBLE (Med)
The AWS mint is `presign GetCallerIdentity` + a **caller-chosen** `x-k8s-aws-id: <cluster>` header; the
token proves only the runner's AWS identity, so **any** EKS cluster in the account that maps the
provisioning role in `aws-auth` accepts it. Untrusted code in the child can invoke
`runner kube-token --provider aws --cluster <any>`. This capability **already exists today**
(`aws-iam-authenticator`/`gcloud` are baked into the fleet images and the same keyless creds are
env-exposed), so it is not strictly *new* reach — but the design's "scoped to the just-provisioned cluster"
implication is **false**, and marketing self-refresh as a day-2 virtue also means untrusted code gets a
*self-renewing* admin oracle rather than a decaying one. **Mitigation:** bind the mint to the job's target
cluster id (reject non-matching `--cluster`); ship the E0 container boundary **before** this; document the
scoping honestly.

### 🟠 R7 — AWS presign correctness is underspecified; a naive implementation yields a token EKS rejects — PLAUSIBLE (Med/High if built naively)
"Zero new deps" is **CONFIRMED true** (`sts v1.41.4` + `internal/presigned-url` + `smithy-go` already
direct deps; no existing presign code — fully net-new). But the one-liner skips the three things
`aws-iam-authenticator` gets right: (1) `x-k8s-aws-id` **must be in the SigV4 SignedHeaders** — inject via a
`smithyhttp.SetHeaderValue` **build-step middleware** before presign, not on the output request; (2) emit
`ExecCredential.status.expirationTimestamp` or client-go won't proactively refresh (breaking the "15-min
ceiling never bites" claim within a single `helm --wait 5m`); (3) `k8s-aws-v1.` + base64url-no-padding +
regional STS host. **Mitigation:** implement via build middleware; unit-test against a known
aws-iam-authenticator vector; always emit `expirationTimestamp`.

### 🟠 R8 — Azure "static cert" works only because AAD-RBAC is off + local accounts enabled — a hardening landmine — CONFIRMED-now / PLAUSIBLE-breaks (Med)
`kube_config_raw` yields a cert today only because `azure/modules/aks/main.tf` has
`role_based_access_control_enabled = true` but **no** `azure_active_directory_role_based_access_control`
block and **no** `local_account_disabled` (defaults false). One line of standard CIS/AKS hardening
(`local_account_disabled = true`, which the active `[[iac-hardening-maxconfig]]` program is likely to add)
flips `kube_config_raw` to a **kubelogin exec block** → the CLI-free runner has no kubelogin → Azure auth
dies silently, no runner code change. **Mitigation:** move Azure to `azidentity` AAD (survives hardening),
or add a `check` block asserting local accounts stay enabled + document the coupling.

### 🟡 R9 — kubeconfig hardcodes `command: /usr/local/bin/runner`; breaks native + self-hosted runners — CONFIRMED (Med)
The sandboxed managed path is fine (binary at `Dockerfile.base:74`; child image is the runner's own,
`container.go:32-34,60-73`). But native local runners (`MODE=native pnpm dev:runner` `go build`s to an
arbitrary path) and self/registered runners run from other paths; a literal
`command: /usr/local/bin/runner` → ENOENT → auth fails. Today's PATH-resolved CLIs don't have this.
**Mitigation:** write `os.Executable()` (resolved absolute) into the kubeconfig, not a compile-time
constant. (Security nuance: it must stay absolute — a PATH-relative command invites a workdir PATH-hijack.)

### 🟡 R10 — `kube-token` branch must be ordered BEFORE the exec-stage re-exec — PLAUSIBLE (Low, correctness)
`main.go:21-27` branches on `ALETHIA_RUNNER_EXEC_STAGE=="1"`, which **is set** in the child
(`container.go:265`) and stays set when kubectl re-invokes the binary. The new `os.Args[1]=="kube-token"`
dispatch **must precede** that check or the plugin call re-enters `RunExecStage` and recurses/hangs.
Secrets are safe either way — `ALETHIA_*` (incl. receipt-signing key, `ALETHIA_STORAGE_*`) are wholesale
denied in the child except `ALETHIA_STAGE_*` (`container.go:332-344`, **verified**).

### 🟡 R11 — Single image collapses today's per-cloud provider-plugin isolation — CONFIRMED (Low–Med)
Per-cloud fleet images init **only their own** template (`Dockerfile.aws:26`, `.gcp:27`, `.azure:22`), so an
AWS VM carries only the aws provider binary. The superset cache puts **all five** providers' binaries on
every VM — a supply-chain compromise in e.g. `alicloud` now sits on AWS VMs where it was absent. Modest
(a plugin runs only when tofu invokes it; pools stay per-cloud) but a real defense-in-depth regression the
doc should acknowledge, not deny.

### 🟡 R12 — Rollback is a global code-lever, not a per-pool flag; only 3 clouds have images to roll back to — PLAUSIBLE (Med, migration)
§6's "behind a fleet flag" doesn't exist: the image name is hardcoded `runner-${provider}` at
`hcloud.ts:59` and the only knob is the global `FLEET_RUNNER_IMAGE_TAG` (`:43`). You cannot stage "AWS pool
new, GCP pool old" — flipping to one image is a code change, and non-aws/gcp/azure pools have **no**
per-cloud image to roll back to. The image-name rename **and** the `renderCloudInit`
`ALETHIA_RUNNER_PROVIDERS` env addition **must ship in the same commit** or new VMs claim **all** clouds
(cross-pool job theft). **Mitigation:** add a real per-pool image override before calling rollback
reversible; ship the two changes atomically.

## Refuted attacks (design is correct here)
- **Concurrent `KUBECONFIG` collision** — REFUTED. Slots are subprocesses with private HOME
  (`supervisor.go:149-179`); `os.Setenv` is process-local; kubeconfig path is HOME-based. No cross-slot
  clobber.
- **Hetzner affected by CLI removal** — REFUTED. Hetzner uses the in-template `alekc/kubectl` provider with
  a Talos cert (`hetzner/main.tf:35`); no cloud CLI shelled.
- **New egress surface / secrets widened** — REFUTED. AWS presign is **offline** (local signing; the runner
  makes no STS call — EKS validates server-side), so AWS needs **no** STS egress, only the cluster API host
  (the design over-listed STS). `ALETHIA_*` secrets remain denied; the minter uses only already-allowlisted
  `AWS_CONFIG_FILE`/`GOOGLE_APPLICATION_CREDENTIALS`.
- **Provider-scoping via cloud-init env** — REFUTED as a risk; `ALETHIA_RUNNER_PROVIDERS` is a runtime env
  (`main.go:127-142`, `bootstrap.go:22`), so moving it to cloud-init is behaviorally identical.

## Bonus finding the design should claim (operability F5)
`hcloud.ts:59` renders `runner-${provider}` for **any** provider, but images exist only for aws/gcp/azure.
The `cloud_provider` enum includes alibaba/hetzner/DO/civo and pools key on `project.provider`, so a
**managed hetzner/alibaba pool references a nonexistent image → `docker run` fails → dead VM.** A single
`runner` image **fixes this live bug** — a stronger motivation than the (thin) size argument.

## Verdict on the design
- **Directionally sound:** the core insight (CLIs are cluster-access only, not auth) and the CLI removal
  itself hold up and are a real SBOM/attack-surface win.
- **The single-image collapse is the weak half** — R3 (per-VM cold-start), R4 (unproven arm64 init), R11
  (plugin isolation), R12 (rollback) all attach to *collapsing images*, not to *removing CLIs*. **The two
  are separable**, and the strongest reframing is: **do CLI-free unconditionally; treat single-image as an
  independent, lower-confidence decision** (or scope it to the co-located box/self-host, keeping lean
  per-cloud fleet images).
- **The cert model (R1/R5/R8) is the security crux** — prefer short-lived minted tokens everywhere
  (Azure via `azidentity`), and fix the pre-existing `execution_metadata` cert leak (R1) regardless.
- **R7/R9/R10** are concrete implementation musts, not blockers.
