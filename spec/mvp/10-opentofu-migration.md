# 10 — Terraform → OpenTofu Migration

**Status:** Accepted (ADR) · **Scope:** mechanical engine swap, no state migration · **Effort:** ~3–5 dev-days, low risk.

## Context

Alethia executes infrastructure-as-code today via **Terraform**, invoked through HashiCorp's `terraform-exec` wrapper. HashiCorp relicensed Terraform to the **BSL (Business Source License)**, which is incompatible with an open-source, self-hostable, copyleft product (see [12-licensing-open-core](12-licensing-open-core.md)). **OpenTofu** is the Linux Foundation fork — **MPL-2.0**, CLI- and state-compatible with the Terraform 1.5/1.6 line, and a drop-in successor.

## Decision

Migrate the IaC engine to **OpenTofu** (the `tofu` binary). Keep `terraform-exec` as the execution wrapper — it runs whatever binary path it is handed, so it is engine-agnostic.

## The swap is localized to one function

`packages/core/terraform/terraform.go` → `ensureBinary` (~lines 138–180):

- **Today:** `exec.LookPath("terraform")`, then hc-install `releases.ExactVersion{Product: product.Terraform}`, cached at `~/.alethia/bin/terraform_<ver>`.
- **Change to:** `exec.LookPath("tofu")`, then fetch the OpenTofu release asset from `github.com/opentofu/opentofu/releases` (verify `SHA256SUMS` + cosign/gpg signature), cached at `~/.alethia/bin/tofu_<ver>`. hc-install's product catalog has **no OpenTofu entry**, so this block is rewritten as a small custom downloader rather than reconfigured.

Everything downstream (`Init/Plan/Apply/Destroy/Output/ShowPlanFile`) goes through `tfexec.Terraform` → **zero call-site changes** in `provisioner/deploy.go`.

## Version pins to update (and a pre-existing bug to fix)

Three hard-coded engine versions:

| Location | Value | Note |
|---|---|---|
| `provisioner/deploy.go:101` | `vc.TerraformVersion` (from the Spec) | comes from DB snapshot |
| `provisioner/bootstrap.go:93` | `"1.7.4"` | valid |
| `provisioner/destroy.go:59` | `"1.15.5"` | **not a real Terraform version — pre-existing bug.** Fix while pinning the OpenTofu default. |

Recommendation: define one `DefaultIaCVersion` constant and reference it everywhere instead of scattered literals.

## State compatibility

State format is **identical** across the TF 1.5/1.6 fork line → this is a binary swap, **not** a state migration. The Supabase S3 backend (`packages/core/cloud/supabase_backend.go`) emits a generic `s3` backend block read identically by `tofu`. No backend change.

## Provider lock files (the real risk)

8 `.terraform.lock.hcl` files under `infra/` pin provider hashes against `registry.terraform.io` (including nested GCP module locks); seed templates (`assets/terraform/seed/`) have none. The working tree already has a modified `infra/platform/.terraform.lock.hcl` — fold it in. OpenTofu defaults to `registry.opentofu.org`.

**Nested ADR — pick one policy repo-wide:**
- **(A) Regenerate** locks via `tofu init -upgrade` (uses the OpenTofu registry mirror). Simple. *Recommended for first-party templates.*
- **(B) Pin** fully-qualified `registry.terraform.io/<ns>/<provider>` source addresses so OpenTofu keeps using the HashiCorp registry. More explicit; identical provider provenance.

Revisit (A) only if a needed provider is missing from the OpenTofu registry.

## Infracost compatibility

`provisioner/deploy.go:202–205` prefers the `ShowPlanJSON` output (a `tfjson.Plan`) fed to `infracost breakdown --path`. **Acid test:** `tofu show -json` must produce a plan Infracost accepts (it does for the 1.6-compatible JSON; pin and verify).

## Validation checklist

1. `tofu version` parity vs the pinned version flow.
2. On a throwaway Zone: `tofu init`/`plan` against an **existing terraform-created state** → assert **no spurious diff** (the acid test for state compatibility).
3. Re-run the dry-run deploy path; confirm plan JSON (`resource_changes`) still populates (the runner reads this).
4. Confirm Infracost breakdown still renders.
5. `go test ./...` in `core`.
6. **Bake the `tofu` binary into the runner Docker image** so it isn't downloaded at runtime.

## Consequences

- License posture aligned (MPL-2.0, no BSL) — a prerequisite for the open-core/self-host story.
- New first-party templates (multi-cloud providers, self-managed cluster strategies — see [09-multi-cloud-cluster-strategies](09-multi-cloud-cluster-strategies.md)) should be authored **tofu-native** from day one. **Do this migration before** writing those new templates.

## Out of scope (deferred)

Renaming the package/type/field names (`terraform/`, `TerraformCLI`, `terraform_version`). These are internal, and `terraform_version` is a DB-snapshot contract — defer to the rename sweep ([A-rename-lexicon](A-rename-lexicon.md)) to limit churn.
