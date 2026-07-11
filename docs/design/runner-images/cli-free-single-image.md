# CLI-free, single-image runner — design

> Status: **DRAFT for maintainer decision.** No code shipped. Companion: [`RED-TEAM.md`](./RED-TEAM.md).
> Scope: `apps/runner`, `packages/core/{cloud,provisioner,k8s}`, `infra/templates/project/*`,
> `apps/console/lib/fleet`, `.github/workflows/deploy-console.yml`.

## TL;DR

The cloud CLIs baked into the runner images (`aws-cli` + `aws-iam-authenticator`, `gcloud` +
`gke-gcloud-auth-plugin`, `azure-cli`) are **not used for cloud/provider authentication** — that is
already fully keyless (OIDC assertion → token file → SDK). They exist for exactly one job:
**getting a kubeconfig to the freshly-provisioned cluster** so the runner can install ArgoCD + add-ons.

Two of the five clouds (**Alibaba, Hetzner**) are already 100% CLI-free — they read a complete
`kubeconfig` from a Terraform output. This design extends that model to AWS/GCP/Azure and then
**collapses `runner-base` + 4 per-cloud images into one image** that "just runs OpenTofu + kubectl +
helm."

**Recommended shape:** a **hybrid keyed on credential lifetime** — embed a static kubeconfig where the
cluster hands us a long-lived **client cert** (Azure, Alibaba, Hetzner), and use the **runner binary
itself as a Kubernetes exec-credential-plugin** where auth is a short-lived **token** (AWS ~15 min;
GCP ~1 h). One image, zero cloud CLIs, no token-expiry cliff. The decision matrix in §11 also scores
the two "pure" alternatives (all-static, all-exec-plugin).

This is **prod provisioning infra**, only fully verifiable on a real VM, so it must land behind the
same real-VM canary as the E0 sandbox (§9).

> **⚠️ Read [`RED-TEAM.md`](./RED-TEAM.md) alongside this.** The adversarial pass materially changed
> the recommendation — see **§0** below, which supersedes the "Recommended shape" above where they
> differ. It also surfaced a **pre-existing security bug** (admin certs in the console DB) to fix
> regardless of this project.

---

## 0. Revised recommendation (after the red-team) — authoritative

The red-team confirmed the core insight but broke several load-bearing claims. Net changes:

1. **Decouple "CLI-free" from "single-image" — they are separate decisions.** Every serious objection
   (per-VM cold-start regression R3, unproven arm64 5-template `tofu init` R4, provider-plugin isolation
   loss R11, global-lever rollback R12) attaches to **collapsing the images**, *not* to **removing the
   CLIs**. Removing the CLIs is a clean, high-confidence win (smaller images, smaller SBOM/CVE surface,
   fewer opaque binaries in the untrusted sandbox) and does not regress the fleet.
   - **Recommended:** ship **CLI-free per-cloud images** first (lean, one provider cache each, no
     cold-start regression). Treat **single-image** as an independent, lower-confidence follow-up — and
     if pursued, scope it to the co-located box + self-host, or bake a pre-pulled Hetzner **snapshot** so
     the fleet doesn't pay the 5-cache pull on every scale-up. (This reverses the original "one image"
     framing; the size argument for one image is thin — R3 — and the real motivation is the F5 bonus
     below, which a single image *or* just fixing `hcloud.ts` both solve.)
2. **Prefer short-lived minted tokens over long-lived certs — including Azure.** The cert model
   (Azure/Alibaba/Hetzner) is a **revocation liability**, not a refresh advantage (R5): a leaked
   cluster-admin cert is valid for the cluster's life with no revocation short of CA rotation, vs
   AWS/GCP tokens that self-expire in minutes. Azure's cert path is also a **hardening landmine** (one
   `local_account_disabled=true` flips `kube_config_raw` to a kubelogin exec block → CLI-free breaks, R8).
   → **Use the runner exec-plugin (short-lived mint) for AWS, GCP, and Azure** (Azure via `azidentity`
   AAD, one new dep). Keep Alibaba/Hetzner on their existing Talos/ACK certs (they have no token
   endpoint), but see #3.
3. **Fix the pre-existing admin-cert-in-DB leak regardless of everything else (R1, High).** All tofu
   outputs — including `sensitive` kubeconfigs — are shipped into `jobs.execution_metadata->outputs` in
   the **console Postgres** (`runner.go:539` + `tofu.go:132-148` + `status/route.ts:56`), readable by DB
   backups/replicas and cross-tenant support staff. **Alibaba/Hetzner already leak their admin kubeconfig
   this way today.** Strip sensitive kubeconfig outputs from `result.Outputs` before `UpdateJobStatus`.
   This is an independent security fix that this exercise happened to surface.
4. **Correct the egress facts (R2, R7):** AWS presign is **offline** — the runner signs locally and makes
   **no** STS call, so AWS needs **no** STS egress, only the cluster API host. GCP token exchange hits
   **`sts.googleapis.com` + `iamcredentials.googleapis.com`** (service-account impersonation), **not**
   `oauth2.googleapis.com`. §5 below is corrected accordingly.
5. **Implementation musts:** write `os.Executable()` (not a hardcoded path) into exec-plugin kubeconfigs
   (R9); order the `kube-token` dispatch **before** the `ALETHIA_RUNNER_EXEC_STAGE` re-exec (R10); bind
   the mint to the job's provisioned cluster id (R6); implement the AWS presign via a `SetHeaderValue`
   build middleware + emit `expirationTimestamp`, unit-tested against a known vector (R7).

The rest of this document is the original design; §5 and §9 are corrected inline; §0 is the position of
record.

---

## 1. Why the CLIs are there (the core insight)

Provider auth is keyless and SDK/file-based; **no CLI participates in it**
(`apps/runner/internal/agent/{aws,gcp,azure,alibaba}_credentials.go`): the console mints an OIDC
assertion (`POST /api/runners/<cloud>-token`), the runner writes it to a token file, and the Terraform
provider / SDK re-reads that file (`AssumeRoleWithWebIdentity`, WIF `external_account`, ARM
client-assertion, `AssumeRoleWithOIDC`). A 5-minute background refresher keeps long applies alive.

The CLIs are invoked in exactly one place — **`ConfigureKubeconfig`, after `tofu apply`**
(`packages/core/provisioner/deploy.go:366`) — to obtain cluster credentials:

| Cloud | `ConfigureKubeconfig` today | Template k8s/helm provider auth (apply-time) | Emits `kubeconfig` output? |
|---|---|---|---|
| AWS | SDK `eks.DescribeCluster` for endpoint+CA, writes kubeconfig with **exec plugin** `aws-iam-authenticator` (`aws_provider.go:315-375`) | `exec { command="aws" eks get-token }` (`aws/main.tf:47-52,60-65`) — **declared but unused** (no k8s/helm resources) | No |
| GCP | **shells** `gcloud container clusters get-credentials` (`gcp_provider.go:190-198`) | `token = data.google_client_config.default.access_token` (`gcp/main.tf:33`) — unused | No (endpoint+CA only) |
| Azure | **shells** `az aks get-credentials` (`azure_provider.go:175-179`) | `client_certificate/client_key` from AKS module (`azure/main.tf:28-42`) — unused | No at project level (`kube_config_raw` lives in the module) |
| Alibaba | reads `kubeconfig` tofu output (`alibaba_provider.go:168`) — **CLI-free** | no k8s/helm provider declared | **Yes** |
| Hetzner | reads `kubeconfig` tofu output (`hetzner_provider.go:110`) — **CLI-free** | `alekc/kubectl` w/ Talos client cert (**used at apply** for Cilium/CCM) | **Yes** |

Crucially, **ArgoCD + marketplace add-ons are installed by the Go runner post-apply**, not by the
templates: `installArgoCD` shells `helm upgrade --install argo-cd … --wait --timeout 5m`
(`deploy.go:552`), then add-ons are rendered as ArgoCD Applications and `kubectl apply`-ed
(`deploy.go:430-435`, `argocd/addons.go:288`). The managed templates declare `kubernetes`/`helm`
providers but define **zero** `helm_release`/`kubernetes_*` resources (Hetzner is the lone exception,
using `alekc/kubectl` with a Talos cert). The kubeconfig hand-off is process-global:
`ConfigureKubeconfig` calls `os.Setenv("KUBECONFIG", …)` and `utils.ExecuteCommand` inherits
`os.Environ()` (`utils/utils.go:74-78`), so every later `helm`/`kubectl` picks it up.

**Therefore:** the kubeconfig only has to authenticate for the **post-apply bootstrap window** — bounded
by the single `helm --wait --timeout 5m`; everything after is short `kubectl apply`s + async ArgoCD
reconcile. Call it **≤ ~10 min** in the normal case.

## 2. Current image topology (what we're collapsing)

- **5 Dockerfiles / 4 deployed images.** `Dockerfile.base` (shared: Go binary, `tofu 1.9.0`, infracost,
  `kubectl`, `helm`, git/ssh, `runner` user, `TF_PLUGIN_CACHE_DIR`, runner+argocd templates) →
  `Dockerfile` (all-cloud `runner`, adds all three CLIs) + `Dockerfile.{aws,gcp,azure}` (each adds one
  CLI). **Alibaba/Hetzner have no image** — they ride the full `runner`.
- **Native per-arch builds, no QEMU** (`deploy-console.yml:61-67`): emulated `tofu init` crashes
  `lfstack.push`, so amd64 (Hetzner CX box) and arm64 (Hetzner CAX fleet) are built natively then
  stitched into a manifest. Per-cloud images are **arm64-only** (fleet).
- Provider plugin cache is **symlinked** into `TF_PLUGIN_CACHE_DIR` at build-time `tofu init`; per-job
  copy preserves symlinks (`deploy.go:604-617`) to avoid hundreds of MB/job.
- Fleet selects the image by name: `ghcr.io/alethialabs-io/runner-${provider}:${tag}`
  (`apps/console/lib/fleet/hcloud.ts:59`); pools are keyed by provider label
  (`alethia-pool=<provider>`). Runner build ≈ **7–8 min** (the slow part of every deploy).

## 3. The design

### 3.1 One image

A single multi-arch `runner` image = Go binary + `tofu` + `kubectl` + `helm` + **all five** project
templates (already `COPY`-ed today) + a superset provider plugin cache + **zero cloud CLIs**. Drop
`Dockerfile.{aws,gcp,azure}`; keep one Dockerfile (fold `Dockerfile.base` into it or keep base as the
only child). The build-time pre-`tofu init` loop extends from `aws azure gcp` to **all five**
(`alibaba hetzner` added), all built natively per-arch (the existing no-QEMU rule already covers this).

Net image size: **deletes three fat CLI toolchains** (the gcloud SDK is the single biggest; azure-cli's
pip tree; aws-cli+python; the two auth-plugin binaries) and **pays once** for a five-cloud provider
cache (adds `alicloud` + `hcloud`/`siderolabs/talos`). Expected **net smaller than today's full
`runner`**, and far smaller than the sum of four images. The 7–8 min runner build becomes **one** build,
not four (per-image CI filtering / `retag-unchanged` for the runner group is retired).

### 3.2 Kubeconfig auth — the hybrid (recommended)

`ConfigureKubeconfig` becomes uniform in shape ("always write a self-contained kubeconfig; never shell a
cloud CLI"), with the `users:` auth block chosen by what the cluster hands us:

- **Static client-cert kubeconfig** — **Azure, Alibaba, Hetzner.** The cluster issues a long-lived,
  CA-signed client cert. Embed it directly. Alibaba/Hetzner already do this; **Azure** needs only a new
  project-level `kubeconfig` output wired from the module's existing `kube_config_raw`
  (`azure/modules/aks/outputs.tf:29-33`) — then `ConfigureKubeconfig` reads it exactly like Alibaba. No
  SDK, no CLI, no TTL cliff.
- **Runner-as-exec-credential-plugin** — **AWS, GCP.** The kubeconfig's `users:` block is an `exec`
  entry pointing at the **runner's own binary**:
  ```yaml
  exec:
    apiVersion: client.authentication.k8s.io/v1beta1
    command: /usr/local/bin/runner
    args: ["kube-token", "--provider", "aws", "--cluster", "<name>", "--region", "<r>"]
  ```
  A new `kube-token` subcommand (an early `os.Args` branch in `apps/runner/cmd/runner/main.go`, beside
  the existing `ALETHIA_RUNNER_EXEC_STAGE` re-exec) mints a fresh token per call via the SDK and prints a
  `client.authentication.k8s.io/v1beta1` `ExecCredential`. This **auto-refreshes** (kubectl re-invokes
  on expiry), so the AWS ~15-min and GCP ~1-h ceilings never bite. Minting reuses the keyless creds
  already active in-process:
  - **AWS**: presign STS `GetCallerIdentity` (+ `x-k8s-aws-id` header) → the `k8s-aws-v1.` token, using
    `aws-sdk-go-v2/service/sts` — **already a direct dependency** (`apps/runner/go.mod`,
    `packages/core/go.mod`). **Zero new deps.** Replaces `aws-iam-authenticator`.
  - **GCP**: OAuth2 access token from the WIF `external_account` creds via `golang.org/x/oauth2/google`
    — **new dep** (currently absent). Replaces `gcloud` + `gke-gcloud-auth-plugin`. (Endpoint+CA come
    from the tofu output, already `sensitive` in `gcp/outputs.tf`.)

Why hybrid rather than uniform: the cert clouds need *nothing* (no dep, no code beyond one Azure output),
and the token clouds get *self-refresh* for free without a new external process. The pure alternatives
(everything static, or everything exec-plugin) are scored in §11.

### 3.3 Template & interface changes

- **`RequiredCLIs()`** → `{"kubectl","helm"}` for all clouds (drop `aws-iam-authenticator`/`gcloud`/`az`).
  This is the exact set `CheckDependencies` preflights (`deploy.go:114-118`); nothing else references the
  CLIs.
- **AWS template** (`aws/main.tf`): the `exec { command="aws" }` blocks are dead today (no k8s/helm
  resources), so they can simply be **deleted** — or, if any future in-template k8s resource is added,
  swapped to `token = data.aws_eks_cluster_auth.<name>.token` (CLI-free). No functional change to the
  current apply.
- **Azure template**: add a project-level `kubeconfig` output = `module.aks[0].kube_config_raw`
  (`azure/outputs.tf`), consumed by the new `ConfigureKubeconfig`.
- **GCP template**: unchanged (endpoint+CA outputs already exist; the runner mints the token).
- **Alibaba/Hetzner**: unchanged.

### 3.4 Fleet & CI

- `hcloud.ts:59` → `ghcr.io/alethialabs-io/runner:${tag}` (drop `-${provider}`). Keep the
  `alethia-pool=<provider>` label for *scheduling*, and pass `ALETHIA_RUNNER_PROVIDERS=<provider>` in the
  cloud-init env (`renderCloudInit`) so a pool still claims only its cloud's jobs even though the image is
  identical (today the *image* implied the provider via `ALETHIA_RUNNER_PROVIDERS` baked per-image).
- `deploy-console.yml`: collapse the runner matrix to **one** multi-arch image
  (`runner-amd64`/`runner-arm64`/`merge-runner`); delete the `runner-aws/gcp/azure` arm64 matrix and the
  per-cloud `retag-unchanged` list. `runner-base` either merges into the single Dockerfile or stays as the
  sole child.

## 4. End-to-end flow after the change (unchanged except the kubeconfig step)

`stage.go:146` → `RunDeployV2`: validate → `NewCloudProvider` → **`CheckDependencies(kubectl,helm)`** →
copy template → tfvars → state-proxy backend → `tofu init/plan` → **elench verify (fail-closed)** →
`apply` → `output` → **`ConfigureKubeconfig` (writes static-cert *or* runner-exec kubeconfig; no CLI)** →
`installArgoCD` (`helm --wait 5m`) → render/apply ArgoCD apps + add-ons (`kubectl`) → health/Trivy reads.
The only touched step is `ConfigureKubeconfig` (+ the image it runs in).

## 5. Security & E0-sandbox interplay

- The exec stage (tofu apply, `ConfigureKubeconfig`, kubectl/helm) runs inside the **container sandbox**
  child when enabled. Today the exec-credential plugins (`aws-iam-authenticator`, etc.) already run there
  and hit STS / `oauth2.googleapis.com` / `login.microsoftonline.com` on the (currently full-egress)
  Passthrough path. **A runner `kube-token` plugin hits the identical endpoints** — so CLI-free adds **no
  new egress surface**; it only makes the endpoint set explicit and drops opaque third-party binaries
  from the sandbox (smaller attack surface).
- The env allowlist already passes exactly what a Go minter needs — `AWS_CONFIG_FILE/AWS_PROFILE/…`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `ARM_*/AZURE_*`, `ALIBABA_*` — plus the OIDC token files RO-mounted by
  directory (`container.go:206-232`), with static keys and `ALETHIA_*` secrets denied
  (`isDeniedEnvKey`). IMDS is unreachable by construction.
- **Forward compatibility with the (in-flight) egress allowlist (E0 3b) — corrected per red-team R2/R7:**
  the future default-deny net must permit, per job:
  - **AWS**: **only the cluster's own API-server host.** The EKS token is a **local presign** — the runner
    makes **no** STS call, so `sts.amazonaws.com` is **not** required (the original draft wrongly listed
    it).
  - **GCP**: **`sts.googleapis.com` + `iamcredentials.googleapis.com`** (WIF is service-account
    impersonation → STS token exchange then `generateAccessToken`), **not** `oauth2.googleapis.com` (the
    original draft wrongly listed it) — plus the GKE API host.
  - **Azure** (if AAD/`azidentity`): `login.microsoftonline.com` + the AKS API host. If the cert path is
    used instead, only the API host.
  - **All clouds**: the cluster API-server host is dynamic (known only post-apply) and is needed by
    `kubectl`/`helm` **regardless of CLIs** — so the allowlist must be per-job/templated either way.
  ⚠️ The exact egress knob names/wiring should be confirmed against the latest E0 Step-3b code — this
  investigation found only the `--network` hook + `ALETHIA_SANDBOX_EGRESS_ENFORCED` gate wired
  (`container.go:67,93-98`), not a concrete allowlist yet.

## 6. Migration & rollback

- **Additive, reversible.** Keep publishing the per-cloud images for one release while the single `runner`
  image ships in parallel; flip the fleet (`hcloud.ts` image name + `ALETHIA_RUNNER_PROVIDERS` in
  cloud-init) behind `FLEET_RUNNER_IMAGE_TAG` / a fleet flag. Roll back = point the fleet tag back at the
  per-cloud images (they still exist).
- The Go changes (`ConfigureKubeconfig`, `kube-token`, `RequiredCLIs`) are backward-compatible with the
  *old* images too (a `runner` binary that no longer shells `gcloud` works in any image), so the binary
  and image rollouts are decoupled.

## 7. Enterprise concerns (addressed head-on)

- **Air-gapped / mirror registries:** fewer external pulls at build (no gcloud tarball / pip index / apt),
  so the image is *easier* to mirror. Provider plugins are already cached in-image.
- **Supply chain / SBOM:** removing aws-cli/gcloud/azure-cli + their Python/pip trees **shrinks the SBOM
  and CVE surface** materially (the Python toolchains are a recurring CVE source). Net security win.
- **FIPS:** Go stdlib crypto (SDK token minting) is more amenable to a FIPS build than shelling
  distro-packaged CLIs.
- **Arch matrix:** unchanged (still native per-arch); one image means **half the build jobs**.
- **Provider-version drift in one cache:** a single image pins one version per provider across all
  templates — already true within a template; the superset cache just holds more providers. Templates
  already pin versions.
- **HA / multi-cluster / day-2:** exec-plugin auth *auto-refreshes*, so day-2 reconnects (drift detect,
  add-on updates) work beyond the token TTL — **better** than a static short-lived token. Cert clouds are
  long-lived by construction.

## 8. Verification & canary (no code ships in this doc)

Runner images are **not locally buildable/testable** (native-arch + `tofu init` cache; see
`[[build-speed]]`), so verification is:
1. **Unit**: `kube-token` ExecCredential JSON shape per cloud; presign correctness (AWS) against a known
   vector; `ConfigureKubeconfig` kubeconfig rendering (golden files).
2. **CI**: the single image builds multi-arch and `tofu init`s all five templates natively.
3. **Real-VM canary** (gating, maintainer): on a fleet VM, provision one cluster per cloud end-to-end and
   assert ArgoCD + add-ons install with **no cloud CLI on PATH** (`which aws gcloud az` empty). Fold into
   the **same real-VM canary already pending for E0 Step-3b** so one VM run validates both.

## 9. Decision matrix (corrected after red-team)

Two orthogonal axes. **Axis 1 — image shape** (independent of auth, per R3/R4/R11/R12):

| Image shape | Per-VM cold-start | arm64 build risk | Plugin isolation | SBOM/CLI win | Verdict |
|---|---|---|---|---|---|
| **CLI-free per-cloud (recommended first)** | unchanged (lean) | unchanged (3 inits) | preserved | **yes** | ship first |
| CLI-free single image | **worse** (5 caches/VM, R3) unless snapshot | **unproven** (5 inits arm64, R4) | lost (R11) | yes | follow-up / box+self-host only |

**Axis 2 — cluster auth** (corrected; certs reframed as a liability per R5/R8, egress per R2/R7):

| Strategy | New deps | Leak blast radius | Day-2 refresh | Hardening-proof | Complexity |
|---|---|---|---|---|---|
| **All-exec-plugin (recommended)** — runner mints for AWS/GCP/Azure(AAD); Alibaba/Hetzner keep Talos/ACK cert | GCP `x/oauth2/google` + Azure `azidentity` | **minutes** (self-expiring tokens) | yes | **yes** (survives AKS `local_account_disabled`) | higher |
| Hybrid — cert static (Az/Ali/Hz) + exec-plugin (AWS/GCP) | GCP only | **cluster lifetime** for Azure cert (R5) | AWS/GCP yes; certs no | **no** — Azure breaks under hardening (R8) | medium |
| All-static — embed token/cert everywhere | none | high; **EKS 15-min snapshot expires mid-bootstrap** (R7) | no | no | low |

Regardless of Axis 2, **fix R1** (strip sensitive kubeconfig outputs from `execution_metadata`) — it is a
current leak, not introduced here.

See [`RED-TEAM.md`](./RED-TEAM.md) for the full ranked findings and evidence behind this matrix.

## 10. Open decisions for the maintainer (revised)

1. **Scope split (the big one)** — accept the red-team's decoupling: ship **CLI-free per-cloud images**
   first, and decide single-image **separately** later? Or still pursue single-image now (accepting the
   R3 cold-start mitigation via a pre-pulled snapshot, and proving R4's arm64 5-template init in CI as a
   hard gate)? *Recommendation: decouple.*
2. **Auth strategy** — all-exec-plugin (recommended: short-lived everywhere, hardening-proof, +2 deps) vs
   hybrid (Azure cert, −1 dep but R5/R8 liabilities). If all-exec-plugin: accept `x/oauth2/google`
   (GCP) + `azidentity` (Azure)?
3. **R1 leak fix** — approve stripping sensitive kubeconfig outputs from `execution_metadata`
   (`runner.go:539`) as a standalone security fix (covers today's Alibaba/Hetzner exposure), independent
   of the auth/image decisions?
4. **GCP fallback** — if avoiding the GCP dep, embed a static ~1-h token (dies ~1 h — OK for bootstrap,
   not day-2 reconnect)? Otherwise take the dep for self-refresh.
5. **Sequencing / canary** — gate behind the E0 Step-3b real-VM canary (one VM validates both), or run an
   independent runner-only canary first (provision one cluster per cloud, assert `which aws gcloud az`
   empty and ArgoCD+add-ons install)?
6. **Motivation framing** — treat the F5 live bug (managed non-aws/gcp/azure pools reference nonexistent
   `runner-${provider}` images → dead VMs) as the real driver; it's fixable by a single image **or** by a
   small `hcloud.ts` change — decide which.
