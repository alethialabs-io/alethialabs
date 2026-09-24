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
of them, and on GCP it would delete and recreate a budget that the billing account shows.

> **A clean plan means NO warnings, including on GCP.** This page used to say the
> `budget_alerts_are_deliverable` check "warns on every plan" and that the warning was expected.
> That stopped being true on 2026-08-27: #1871's cause was a wrong principal name
> (`billing-budget-alert@`, not `billing-budgets@`), the binding is live, and
> `budget_publisher_binding_enabled` now **defaults `true`** — so the check passes and a plan emits
> nothing. Expect a clean plan with no `Warning:` block. If that warning reappears, something
> changed; find out what before migrating, rather than waving it through as a known one.

## The chicken-and-egg, and how it is resolved

A stack cannot keep its state in a bucket it has not created yet. **All three stacks** papered over
this with an untracked `backend_override.tf` forcing `backend "local" {}` — each self-labelled
TEMPORARY, and none removed. `infra/azure-e2e`'s dates from 2026-08-03; `infra/gcp-e2e`'s and
`infra/alibaba-e2e`'s were added on 2026-08-25.

The resolution is the one `infra/email-ses/bootstrap` already uses on the AWS side: **a separate
bootstrap stack per cloud**, applied first, that owns nothing but the state container and the sink
its access logs go to.

```
infra/gcp-e2e/bootstrap/       → a GCS bucket        (versioned, UBLA, public access prevented)
                                 + a `<bucket>-logs` sink for its usage logs
infra/azure-e2e/bootstrap/     → an RG + storage account + container
                                 (versioned, soft-delete, shared keys DISABLED)
                                 + a Log Analytics workspace for its blob access logs
infra/alibaba-e2e/bootstrap/   → an OSS bucket       (versioned, SSE, public access blocked)
                                 + a `<bucket>-logs` sink for its access logs
```

The state container in each carries `prevent_destroy = true` and refuses a force-destroy, so
`tofu destroy` on the bootstrap cannot take the state with it. The log sinks carry it too, and are
bounded by a retention rule (90 days) rather than by anyone deleting them.

The sinks are deliberately **separate** from the state containers, which is why the verification
steps below can still expect exactly two objects in the state bucket.

Each bootstrap then keeps **its own** state in the container it just created. That recursion
terminates in one documented two-phase init — a temporary local-backend override, apply, delete the
override, then `-migrate-state` — and after that everything is plain remote state. It is written
out per cloud below.

> **`tofu init -backend=false` is NOT the first phase.** This page used to say `tofu init
> -backend=false && tofu apply`. That fails: `-backend=false` only skips configuring the declared
> backend, so the plan inside `apply` refuses with exit 1 —
> `Error: Backend initialization required, please run "tofu init"` ·
> `Reason: Initial configuration of the requested backend "gcs"` (`azurerm` / `oss` on the other two).
> `-backend=false` is enough for `validate` and `test`, never for `plan` or `apply`. The working form
> is a `backend_override.tf` in the **bootstrap** directory forcing `backend "local" {}`, removed
> again before the migrate init — the same file this page tells you to delete from the parents,
> used here on purpose and for one apply only.

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

## The override is on ALL THREE stacks, and forgetting it fails SILENTLY

This is the one step on this page whose failure produces no error, no red, and no prompt. Read it
before you run anything.

`tofu init` merges `*_override.tf` **at init time**. If a `backend_override.tf` forcing
`backend "local" {}` is present when you init, OpenTofu configures the **local** backend, prints no
migration prompt, and **exits 0**. You then delete the override, believe you are on the remote
backend, and are not — and every apply from then on writes state to your laptop, exactly the
condition #1887 exists to end.

Measured, against a stack declaring `backend "gcs" {}` with the override in place:

```
$ tofu init
Initializing the backend...

Successfully configured the backend "local"!        ← the whole warning, in one line
...
OpenTofu has been successfully initialized!
$ echo $?
0
$ jq -r '.backend.type' .terraform/terraform.tfstate
local
```

**Census before you start.** All three have one; confirm what is actually on this machine, because
`infra/.gitignore`'s `**/*_override.tf` keeps every one of them out of `git status`:

```bash
for d in infra/gcp-e2e infra/azure-e2e infra/alibaba-e2e; do
  printf '%-22s %s\n' "$d" \
    "$(test -f "$d/backend_override.tf" && echo 'OVERRIDE PRESENT — delete before its parent init' || echo 'none')"
done
```

**Two checks, and every stack section below runs both.** They are cheap and they are the only
things that distinguish a real migration from a green no-op:

```bash
# BEFORE the parent `init` — the override must be gone.
test -f backend_override.tf && { echo 'STILL PRESENT — DO NOT INIT'; false; } || echo 'override gone'

# AFTER the parent `init` — the recorded backend must not be "local".
jq -r '.backend.type' .terraform/terraform.tfstate
#   expect gcs | azurerm | oss   ·   "local" means the migration did not happen
```

> **Delete the FILES. Keep the `.gitignore` RULE.** `infra/.gitignore`'s `**/*_override.tf` is a
> deliberate control citing #1887 — a *committed* override silently re-points every operator, which
> is how `infra/azure-e2e` spent months on a `backend "local" {}` nobody meant to keep. Removing
> that rule would re-open the hole this procedure closes. Nothing on this page asks you to touch it.

If you do get trapped, you are not stuck: once the override is gone, the next `tofu init` **fails**
with `Error: Backend configuration changed` (exit 1) and names `-migrate-state`. That error is the
recovery path, not a new problem. What has no recovery is never noticing.

## Order

Do the clouds one at a time and finish each before starting the next. Within a cloud the order is
fixed: **delete the parent's override → bootstrap apply → bootstrap migrate → parent migrate**.

There is no dependency *between* clouds, so if one goes wrong you can stop there and the other two
are untouched.

---

## 1. GCP

The live stack is **not** in a project called `alethia-e2e-nightly`. That string is the provisioner
service account's account id (`service_account_id`), and the examples used to carry it as the
project id too — copy them unedited and the bootstrap would create a bucket in, and name it after, a
project that holds none of this stack's resources. The real project is the one every resource in
the parent's state sits in, and the one both repo variables name: `E2E_GCP_SA_EMAIL` is
`alethia-e2e-nightly@<project>.iam.gserviceaccount.com`, and `E2E_GCP_WIF_PROVIDER` begins with
that project's **number**.

Its id is not written in this repo on purpose — `pnpm check:forbidden-names` refuses it (see
`compliance/forbidden-name-hashes.json`), and GCP project ids cannot be renamed — so this page calls
it `${GCP_E2E_PROJECT_ID}` and you read it from the variable. Confirm the two sources agree before
you apply anything:

```bash
GCP_E2E_PROJECT_ID="$(gh variable get E2E_GCP_SA_EMAIL | sed -E 's/^[^@]+@([^.]+)\.iam\.gserviceaccount\.com$/\1/')"
echo "$GCP_E2E_PROJECT_ID"
jq -r '[.resources[].instances[].attributes.project // empty] | unique[]' infra/gcp-e2e/terraform.tfstate
#   expect exactly one line, equal to the echo above. The derived state bucket is then
#   alethia-tofu-state-${GCP_E2E_PROJECT_ID}.
```

```bash
cd infra/gcp-e2e/bootstrap
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars          # project_id = ${GCP_E2E_PROJECT_ID} — the SAME project as the parent stack

# 1a. First apply, local state — the bucket does not exist yet. A TEMPORARY override in the
#     BOOTSTRAP directory (not `-backend=false`, which cannot plan — see above).
cat > backend_override.tf <<'EOF'
terraform {
  backend "local" {}
}
EOF
tofu init
tofu plan -out=bootstrap.tfplan   # creates only: the state bucket, its `-logs` sink, the sink's writer binding
tofu apply bootstrap.tfplan

tofu output -raw state_bucket     # note this name; it goes in BOTH backend.hcl files
```

```bash
# 1b. Move the bootstrap's own state into the bucket it just made.
#     DELETE THE BOOTSTRAP'S OVERRIDE FIRST — with it present the init below configures `local`
#     again, prints no prompt and exits 0.
rm -f backend_override.tf bootstrap.tfplan
test -f backend_override.tf && { echo 'STILL PRESENT — DO NOT INIT'; false; } || echo 'override gone'

cp backend.hcl.example backend.hcl
$EDITOR backend.hcl               # bucket = the name printed above
tofu init -backend-config=backend.hcl -migrate-state
jq -r '.backend.type' .terraform/terraform.tfstate     # expect: gcs
```

OpenTofu prints the source and destination and asks for `yes`. **Read the prompt** — confirm it says
it is copying from `local` to `gcs`, not the other way round.

```bash
# 1c. Now the parent stack — DELETE THE OVERRIDE FIRST.
cd ..
ls -l backend_override.tf 2>/dev/null || echo "already gone"
rm -f backend_override.tf
test -f backend_override.tf && { echo 'STILL PRESENT — DO NOT INIT'; false; } || echo 'override gone'

cp backend.hcl.example backend.hcl
$EDITOR backend.hcl               # same bucket; prefix stays gcp-e2e
tofu init -backend-config=backend.hcl -migrate-state
```

`infra/gcp-e2e` has an override too (added 2026-08-25). Init with it still there and you get a
green, exit-0 init onto the **local** backend and no migration prompt — see the section above.

**Verify:**

```bash
# The migration actually happened — not "local".
jq -r '.backend.type' .terraform/terraform.tfstate     # expect: gcs

gcloud storage ls "gs://$(cd bootstrap && tofu output -raw state_bucket)/**"
#   expect EXACTLY gcp-e2e/default.tfstate and gcp-e2e-bootstrap/default.tfstate
#   (usage logs go to the separate `-logs` sink, so they do not appear here)

tofu plan -var-file=<(printf 'e2e_broker_issuer_url = null\n')     # in infra/gcp-e2e — see below
```

**Why the plan needs that `-var-file`.** The committed `terraform.tfvars` sets
`e2e_broker_issuer_url = "https://e2e-issuer.alethialabs.io"` (#4226), and that broker trust has
not been applied. A bare `tofu plan` on current `dev` therefore proposes **3 to add** — the broker
WIF pool, its provider and the SA binding (`e2e-broker.tf`) — and that is correct, not a failed
migration. The migration question is "did the state come across", so ask it with the broker set
back to its default `null`; the later `-var-file` wins over `terraform.tfvars`. Applying the broker
is a separate step (`docs/testing/e2e-federation-apply-runbook.md`), taken only once
`https://e2e-issuer.alethialabs.io` actually serves — **do not** apply with this override either:
that would record the broker as absent.

> **Not `-var e2e_broker_issuer_url=null`.** For a `string`-typed variable `-var` passes the literal
> four-character string `"null"`, which fails the variable's validation (measured). `null` only
> reaches the variable as HCL, which is what the `-var-file` gives it. zsh and bash both support the
> `<(…)` form; any file containing that one line works the same.

With that override, the plan must be **"No changes"** with **no `Warning:` block at all** — see the
note at the top of
this page; the old `budget_alerts_are_deliverable` warning is gone and its return is a signal, not
an expectation. Anything else — especially a proposed *create* of the WIF pool, the SA or the
budget — means the parent stack did not carry its state across. **Stop**, restore
`terraform.tfstate` from the backup, and work out why before applying anything.

---

## 2. Azure

Azure's override is the oldest of the three (2026-08-03) — it is the one #1887 was written about.
It has to go before the parent `init`, or that init configures the local backend, prints no
migration prompt and exits 0.

```bash
# 2a. Is the override still there? It is untracked, and `infra/.gitignore` hides it from
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
# 2a (cont). First apply, local state — the same temporary BOOTSTRAP override as GCP's 1a.
cat > backend_override.tf <<'EOF'
terraform {
  backend "local" {}
}
EOF
tofu init
tofu plan -out=bootstrap.tfplan   # RG, storage account, container, writer role assignment(s),
                                  # Log Analytics workspace, diagnostic setting
tofu apply bootstrap.tfplan
```

`state_writer_principal_ids` is not optional. The account is created with
`shared_access_key_enabled = false` — there is no storage key in existence to leak — so the only way
to read or write state is a `Storage Blob Data Contributor` assignment. Leave it empty and the very
next `init` 403s in a way that reads like a backend bug. The bootstrap's
`state_has_at_least_one_writer` check warns at plan time if you do.

**Wait about five minutes after the apply before step 2b.** The apply grants the writer role, and
Entra role assignments take minutes to reach the blob data plane; a migrate init run straight away
gets a **403** that reads like a backend bug. A 403 here means *wait and retry* — do not change the
config, the role or the account.

```bash
# 2b. Move the bootstrap's own state in — DELETE THE BOOTSTRAP'S OVERRIDE FIRST.
rm -f backend_override.tf bootstrap.tfplan
test -f backend_override.tf && { echo 'STILL PRESENT — DO NOT INIT'; false; } || echo 'override gone'

cp backend.hcl.example backend.hcl
$EDITOR backend.hcl               # names from `tofu output`; keep use_azuread_auth = true
tofu init -backend-config=backend.hcl -migrate-state
```

```bash
# 2c. The parent stack — DELETE THE OVERRIDE FIRST.
cd ..
rm -f backend_override.tf         # the TEMPORARY local-state override; its own comment says to
test -f backend_override.tf && { echo 'STILL PRESENT — DO NOT INIT'; false; } || echo 'override gone'

cp backend.hcl.example backend.hcl
$EDITOR backend.hcl               # same account/container, key = azure-e2e.tfstate
tofu init -backend-config=backend.hcl -migrate-state
```

If you delete the override *after* re-initialising, the init you already ran configured the local
backend and the migration prompt never appears. It exits 0 and reads as success. Delete first, and
check the file is gone with the `test -f` above rather than trusting the `rm`.

**Verify:**

```bash
# The migration actually happened — not "local".
jq -r '.backend.type' .terraform/terraform.tfstate     # expect: azurerm

az storage blob list --auth-mode login \
  --account-name "$(cd bootstrap && tofu output -raw state_storage_account_name)" \
  --container-name "$(cd bootstrap && tofu output -raw state_container_name)" -o table
#   expect azure-e2e.tfstate and azure-e2e-bootstrap.tfstate

test -f backend_override.tf && echo "OVERRIDE STILL PRESENT — you are still on local state"

tofu plan -var-file=<(printf 'e2e_broker_issuer_url = null\n')     # in infra/azure-e2e — must be "No changes"
```

The `-var-file` is there for the same reason as GCP's: the committed `terraform.tfvars` sets
`e2e_broker_issuer_url`, so a bare plan on current `dev` proposes **1 to add** — the broker
federated credential (`e2e-broker.tf`) — until that trust is applied. That add is expected and is
not evidence about the migration; do not apply with the override.

A proposed *create* of `azuread_application` would mean a new client id, which would invalidate the
`E2E_AZURE_CLIENT_ID` repo variable and break the nightly. Treat it as a stop.

---

## 3. Alibaba

> **Optional, and billable.** The Alibaba account is unfunded — the maintainer ruled on 2026-09-19
> that it will not be funded — and its nightly leg is muted (#2545), so nothing reads this stack
> today and nothing breaks if its state stays local a while longer; keep the backup either way. Migrating it is not free: the bootstrap creates **7 billable OSS
> resources** (the state bucket and its `-logs` sink, each with an ACL and a public-access block,
> plus the bucket-logging link). Do it if that ruling changes, or when a second person needs to
> apply this stack — not merely to finish the list.

```bash
cd infra/alibaba-e2e/bootstrap
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars          # region must match backend.hcl's region

export ALICLOUD_ACCESS_KEY=...  ALICLOUD_SECRET_KEY=...     # admin identity
# 3a. First apply, local state — the same temporary BOOTSTRAP override as GCP's 1a.
cat > backend_override.tf <<'EOF'
terraform {
  backend "local" {}
}
EOF
tofu init
tofu plan -out=bootstrap.tfplan   # creates the 7 OSS resources above
tofu apply bootstrap.tfplan

tofu output -raw state_bucket
```

```bash
# 3b. Move the bootstrap's own state in — DELETE THE BOOTSTRAP'S OVERRIDE FIRST.
rm -f backend_override.tf bootstrap.tfplan
test -f backend_override.tf && { echo 'STILL PRESENT — DO NOT INIT'; false; } || echo 'override gone'

cp backend.hcl.example backend.hcl
$EDITOR backend.hcl               # bucket + region
tofu init -backend-config=backend.hcl -migrate-state
```

```bash
# 3c. The parent stack — DELETE THE OVERRIDE FIRST.
cd ..
ls -l backend_override.tf 2>/dev/null || echo "already gone"
rm -f backend_override.tf
test -f backend_override.tf && { echo 'STILL PRESENT — DO NOT INIT'; false; } || echo 'override gone'

cp backend.hcl.example backend.hcl
$EDITOR backend.hcl               # same bucket; prefix stays alibaba-e2e
tofu init -backend-config=backend.hcl -migrate-state
```

`infra/alibaba-e2e` has an override too (added 2026-08-25). Init with it still there and you get a
green, exit-0 init onto the **local** backend and no migration prompt — see the section above.

**Verify:**

```bash
# The migration actually happened — not "local".
jq -r '.backend.type' .terraform/terraform.tfstate     # expect: oss

aliyun oss ls "oss://$(cd bootstrap && tofu output -raw state_bucket)/" --recursive
#   expect EXACTLY alibaba-e2e/terraform.tfstate and alibaba-e2e-bootstrap/terraform.tfstate
#   (access logs go to the separate `-logs` sink, so they do not appear here)

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
# No local state and NO OVERRIDE left anywhere under the e2e stacks. Both, in one sweep:
# a surviving override is one `init` away from putting a stack back on local state.
find infra/gcp-e2e infra/azure-e2e infra/alibaba-e2e \
     \( -name 'terraform.tfstate*' -o -name 'backend_override.tf' \) -print
#   expect NO OUTPUT once the backups below have been cleared — except under infra/alibaba-e2e if
#   you skipped the optional Alibaba migration (§3), whose local state and override stay as they were

# What each stack DECLARES...
for d in infra/aws-oidc infra/gcp-e2e infra/azure-e2e infra/alibaba-e2e; do
  echo "== $d"; grep -A1 'backend "' "$d/backend.tf"
done

# ...and what each stack is ACTUALLY INITIALISED ON. This is the one that can disagree, and it is
# the whole point: a declared `backend "gcs" {}` sitting on a recorded "local" is the silent
# failure this procedure exists to prevent.
for d in infra/gcp-e2e infra/gcp-e2e/bootstrap infra/azure-e2e infra/azure-e2e/bootstrap \
         infra/alibaba-e2e infra/alibaba-e2e/bootstrap; do
  printf '%-34s %s\n' "$d" \
    "$(jq -r '.backend.type // "no .terraform record"' "$d/.terraform/terraform.tfstate" 2>/dev/null \
       || echo 'no .terraform record')"
done
#   expect gcs · gcs · azurerm · azurerm · oss · oss — and never "local"
```

`tofu init -migrate-state` leaves the old file behind as `terraform.tfstate.backup`. Keep it, along
with the off-machine backup, until you have had a clean plan from each stack. Then delete both from
the working tree — the remote copy is the source of truth from here on, and a stale local file is
one local-backend override away from being picked up again.

Nothing in the nightly changes: no repo variable moves, no workflow reads state, and the identities
themselves are untouched. If a leg is enabled, the next scheduled run is the confirmation.

### Access logging

Each bootstrap also stands up the sink its state container's access logs go to (#4903). Nothing in
this procedure reads them and no alarm is wired to them — they are a forensic record you go to
after you have a reason. Delivery is not synchronous with the request on any of the three, so an
empty sink shortly after a migration means "not delivered yet", not "not configured".

```bash
gcloud storage ls "gs://$(cd infra/gcp-e2e/bootstrap && tofu output -raw state_log_bucket)/"
aliyun oss ls "oss://$(cd infra/alibaba-e2e/bootstrap && tofu output -raw state_log_bucket)/" --recursive
# Azure: query the `StorageBlobLogs` table in the workspace named by
#   tofu -chdir=infra/azure-e2e/bootstrap output -raw state_log_workspace_name
```

## Related

- `docs/testing/e2e-nightly-enablement.md` — taking a cloud from inert to proven
- `infra/README.md` — the stack/state table and the apply order
- `infra/aws-oidc/README.md` — the stack that already did this, and the pattern the other three now
  match
