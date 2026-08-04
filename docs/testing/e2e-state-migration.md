<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Moving the e2e federation stacks onto remote state

The OIDC/WIF plane the whole T2 nightly authenticates through is four stacks. One of them —
`infra/aws-oidc` — has always kept its state in S3. The other three kept theirs in a
`terraform.tfstate` file in the working tree, which means they exist on exactly one laptop and
nobody else can apply them at all (#1887).

This is the procedure that fixes that. It is **maintainer work**: it applies real cloud
infrastructure and it moves live state. Agents do neither.

> **Agents must not run `tofu apply`, `tofu destroy`, or `tofu init -migrate-state`.** The first two
> are refused by the harness; the third is a maintainer act on live, billable identity. See the IaC
> rules in `CLAUDE.md`.

## What is at risk if you get it wrong

These stacks own identity that is expensive to rebuild and, in one case, visible on a billing
account:

| stack | owns |
| --- | --- |
| `infra/gcp-e2e` | WIF pool + ref-bound provider, the provisioner SA and its project role bindings, a Pub/Sub topic, a **Cloud Billing budget** |
| `infra/azure-e2e` | Entra application + service principal, the GitHub federated credential, three subscription role assignments, the AKS admin group |
| `infra/alibaba-e2e` | RAM OIDC provider, the `alethia-e2e-nightly` role, its least-privilege policy |

**Migrate; never re-apply from empty state.** A fresh apply against live resources fights every one
of them, and on GCP it would delete and recreate a budget that the billing account shows. The GCP
publisher binding is also already in a known-incomplete state (#1871) — `budget_publisher_binding_enabled`
is `false` on purpose, and the `budget_alerts_are_deliverable` check warns on every plan. That
warning is expected; it is not migration damage.

## The chicken-and-egg, and how it is resolved

A stack cannot keep its state in a bucket it has not created yet. `infra/azure-e2e` papered over
this with an untracked `backend_override.tf` forcing `backend "local" {}` — self-labelled
TEMPORARY, and never removed.

The resolution is the one `infra/email-ses/bootstrap` already uses on the AWS side: **a separate
one-resource bootstrap stack per cloud**, applied first, that owns nothing but the state container.

```
infra/gcp-e2e/bootstrap/       → a GCS bucket        (versioned, UBLA, public access prevented)
infra/azure-e2e/bootstrap/     → an RG + storage account + container
                                 (versioned, soft-delete, shared keys DISABLED)
infra/alibaba-e2e/bootstrap/   → an OSS bucket       (versioned, SSE, public access blocked)
```

Every one carries `prevent_destroy = true` and refuses a force-destroy, so `tofu destroy` on the
bootstrap cannot take the state with it.

Each bootstrap then keeps **its own** state in the container it just created. That recursion
terminates in one documented two-phase init — `-backend=false`, apply, then `-migrate-state` — and
after that everything is plain remote state. It is written out per cloud below.

## Before you touch anything

```bash
# 1. You are on a branch with this change. Confirm the backends are declared.
grep -r 'backend "' infra/gcp-e2e/backend.tf infra/azure-e2e/backend.tf infra/alibaba-e2e/backend.tf

# 2. BACK UP EVERY LOCAL STATE FILE, off this machine. This is the only copy that exists.
mkdir -p ~/alethia-state-backup/$(date +%Y%m%d)
cd ~/alethia-state-backup/$(date +%Y%m%d)
for s in gcp-e2e azure-e2e alibaba-e2e; do
  cp "$OLDPWD/infra/$s/terraform.tfstate" "./$s.tfstate" 2>/dev/null \
    && echo "backed up $s" || echo "NO LOCAL STATE for $s — stop and find out why"
done
shasum -a 256 ./*.tfstate | tee ./SHA256SUMS
```

Keep that directory until every stack has produced a clean `tofu plan` against the remote backend.
It is your only rollback.

> The Bash tool runs zsh, where `for x in $LIST` does **not** word-split — the loop above iterates a
> literal list, which does. If you adapt it, keep the literal list or use an array.

Also confirm what state each stack actually has right now, so you migrate what you think you are
migrating:

```bash
for d in infra/gcp-e2e infra/azure-e2e infra/alibaba-e2e; do
  echo "== $d"; ls -l "$d"/terraform.tfstate 2>/dev/null || echo "  (none)"
done
```

## Order

Do the clouds one at a time and finish each before starting the next. Within a cloud the order is
fixed: **bootstrap apply → bootstrap migrate → parent migrate**.

There is no dependency *between* clouds, so if one goes wrong you can stop there and the other two
are untouched.

---

## 1. GCP

```bash
cd infra/gcp-e2e/bootstrap
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars          # project_id MUST match the parent stack's project_id

# 1a. First apply, local state — the bucket does not exist yet.
tofu init -backend=false
tofu apply                        # creates exactly one GCS bucket

tofu output -raw state_bucket     # note this name; it goes in BOTH backend.hcl files
```

```bash
# 1b. Move the bootstrap's own state into the bucket it just made.
cp backend.hcl.example backend.hcl
$EDITOR backend.hcl               # bucket = the name printed above
tofu init -backend-config=backend.hcl -migrate-state
```

OpenTofu prints the source and destination and asks for `yes`. **Read the prompt** — confirm it says
it is copying from `local` to `gcs`, not the other way round.

```bash
# 1c. Now the parent stack.
cd ..
cp backend.hcl.example backend.hcl
$EDITOR backend.hcl               # same bucket; prefix stays gcp-e2e
tofu init -backend-config=backend.hcl -migrate-state
```

**Verify:**

```bash
gcloud storage ls "gs://$(cd bootstrap && tofu output -raw state_bucket)/**"
#   expect gcp-e2e/default.tfstate and gcp-e2e-bootstrap/default.tfstate

tofu plan     # in infra/gcp-e2e
```

The plan must be **"No changes"**, apart from the standing
`budget_alerts_are_deliverable` warning (#1871). Anything else — especially a proposed *create* of
the WIF pool, the SA or the budget — means the parent stack did not carry its state across. **Stop**,
restore `terraform.tfstate` from the backup, and work out why before applying anything.

---

## 2. Azure

Azure has the extra step: the `backend_override.tf` that forced local state has to go, or every
subsequent `init` silently ignores the real backend.

```bash
# 2a. Is the override still there? It is untracked, and `infra/.gitignore` now hides it from
#     `git status`, so check for the file directly.
ls -l infra/azure-e2e/backend_override.tf 2>/dev/null || echo "already gone"
```

```bash
cd infra/azure-e2e/bootstrap
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars
#   subscription_id            = the SAME subscription as the parent stack
#   state_writer_principal_ids = your Entra object id — `az ad signed-in-user show --query id -o tsv`

az login
tofu init -backend=false
tofu apply                        # RG + storage account + container
```

`state_writer_principal_ids` is not optional. The account is created with
`shared_access_key_enabled = false` — there is no storage key in existence to leak — so the only way
to read or write state is a `Storage Blob Data Contributor` assignment. Leave it empty and the very
next `init` 403s in a way that reads like a backend bug. The bootstrap's
`state_has_at_least_one_writer` check warns at plan time if you do.

Entra role assignments take a few minutes to propagate to the blob data plane. If step 2b 403s,
wait five minutes and retry before changing anything.

```bash
# 2b. Move the bootstrap's own state in.
cp backend.hcl.example backend.hcl
$EDITOR backend.hcl               # names from `tofu output`; keep use_azuread_auth = true
tofu init -backend-config=backend.hcl -migrate-state
```

```bash
# 2c. The parent stack — DELETE THE OVERRIDE FIRST.
cd ..
rm -f backend_override.tf         # the TEMPORARY local-state override; its own comment says to
cp backend.hcl.example backend.hcl
$EDITOR backend.hcl               # same account/container, key = azure-e2e.tfstate
tofu init -backend-config=backend.hcl -migrate-state
```

If you delete the override *after* re-initialising, the init you already ran configured the local
backend and the migration prompt never appears. Delete first.

**Verify:**

```bash
az storage blob list --auth-mode login \
  --account-name "$(cd bootstrap && tofu output -raw state_storage_account_name)" \
  --container-name "$(cd bootstrap && tofu output -raw state_container_name)" -o table
#   expect azure-e2e.tfstate and azure-e2e-bootstrap.tfstate

test -f backend_override.tf && echo "OVERRIDE STILL PRESENT — you are still on local state"

tofu plan     # in infra/azure-e2e — must be "No changes"
```

A proposed *create* of `azuread_application` would mean a new client id, which would invalidate the
`E2E_AZURE_CLIENT_ID` repo variable and break the nightly. Treat it as a stop.

---

## 3. Alibaba

```bash
cd infra/alibaba-e2e/bootstrap
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars          # region must match backend.hcl's region

export ALICLOUD_ACCESS_KEY=...  ALICLOUD_SECRET_KEY=...     # admin identity
tofu init -backend=false
tofu apply                        # creates one OSS bucket

tofu output -raw state_bucket
```

```bash
# 3b. Move the bootstrap's own state in.
cp backend.hcl.example backend.hcl
$EDITOR backend.hcl               # bucket + region
tofu init -backend-config=backend.hcl -migrate-state
```

```bash
# 3c. The parent stack.
cd ..
cp backend.hcl.example backend.hcl
$EDITOR backend.hcl               # same bucket; prefix stays alibaba-e2e
tofu init -backend-config=backend.hcl -migrate-state
```

**Verify:**

```bash
aliyun oss ls "oss://$(cd bootstrap && tofu output -raw state_bucket)/" --recursive
#   expect alibaba-e2e/terraform.tfstate and alibaba-e2e-bootstrap/terraform.tfstate

tofu plan     # in infra/alibaba-e2e — must be "No changes"
```

`region` in `backend.hcl` must match the bucket's region: the OSS backend builds its endpoint from
that value (`oss-<region>.aliyuncs.com`), so a mismatch surfaces as *bucket not found* rather than
as a redirect.

**The OSS backend does not lock.** Locking needs a TableStore instance and table, and this repo does
not stand one up for a stack exactly one person applies by hand. If a second operator is ever given
these credentials, add `tablestore_endpoint` + `tablestore_table` to `backend.hcl` and the matching
resources to `bootstrap/` first. Mind the 16-character cap on a TableStore instance name (#1884).

---

## After all three

```bash
# No local state left anywhere under the e2e stacks.
find infra/gcp-e2e infra/azure-e2e infra/alibaba-e2e -name 'terraform.tfstate*' -print

# Each stack reports the remote backend it now uses.
for d in infra/aws-oidc infra/gcp-e2e infra/azure-e2e infra/alibaba-e2e; do
  echo "== $d"; grep -A1 'backend "' "$d/backend.tf"
done
```

`tofu init -migrate-state` leaves the old file behind as `terraform.tfstate.backup`. Keep it, along
with the off-machine backup, until you have had a clean plan from each stack. Then delete both from
the working tree — the remote copy is the source of truth from here on, and a stale local file is
one `-backend=false` away from being picked up again.

Nothing in the nightly changes: no repo variable moves, no workflow reads state, and the identities
themselves are untouched. If a leg is enabled, the next scheduled run is the confirmation.

## Related

- `docs/testing/e2e-nightly-enablement.md` — taking a cloud from inert to proven
- `infra/README.md` — the stack/state table and the apply order
- `infra/aws-oidc/README.md` — the stack that already did this, and the pattern the other three now
  match
