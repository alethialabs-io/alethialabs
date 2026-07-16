---
name: alethia-security-review
description: Review a change against Alethia's real threat surface — keyless/no-key-leakage, ReBAC authz, Postgres RLS tenant isolation, the untrusted BYO-IaC sandbox + state proxy, secret handling, the open-core ee/ boundary, and the runner's mint-bind/receipt signing. Use before shipping any change that touches auth, credentials, secrets, tenant data, the runner, provisioning, or the ee/ tier. Complements (does not replace) the generic security-review skill.
user-invocable: true
---

# Alethia security review

Alethia's entire pitch is **"hold zero keys · prove it · keep proving it."** A security regression here is
not a generic bug — it breaks the product's core claim. Review the change (default: the current diff vs
`dev`; or a named file set) against the seams below. For each finding, name the **seam**, the **file:line**,
the **failure scenario** (concrete inputs → what leaks/breaks), and the **fix**. If a seam isn't touched by
the change, skip it — don't pad.

Run the generic `security-review` skill too for the language-level classes (injection, SSRF, path traversal,
deserialization). This skill covers the **Alethia-specific** surfaces that generic review misses.

## The seams

### 1. Keyless — no credential ever lands at rest
The control plane never stores cloud keys; the runner assumes roles at execution time (AWS AssumeRole / GCP
WIF / Azure federated, switched on `cloud_identity.provider`). **Canonical failure (real: A0.0):** a secret
leaked into `execution_metadata` as plaintext (`argocd_admin_password`), and that column is persisted +
surfaceable. Check:
- No cloud credential, token, kubeconfig secret, or generated password written into `config_snapshot`,
  `execution_metadata`, `job_logs`, or any persisted column — these are dumps waiting to happen.
- No credential in log lines (the runner ships logs to `job_logs`). Auth uses a struct/exec-plugin, never a
  tokenized URL.
- The runner mints short-lived creds in-process (`runner kube-token`); nothing long-lived is written to disk.

### 2. ReBAC / OpenFGA authz — every mutation is gated
Authorization is OpenFGA (relationship-based). Check every new server action / API route / AI tool that
mutates is PDP-gated (a permission check before the write), and that a check can't be bypassed by calling a
lower layer directly. AI agent tools especially: a `propose_*` tool must not gain an `execute` path that
skips the human/PDP gate.

### 3. Postgres RLS — tenant isolation
Data access goes through `getServiceDb` / `withOwnerScope` (RLS-scoped). Check: no raw service-role query
that reads/writes another org's rows without an owner scope; **all `cloud_identities` queries filter by
`provider`** (a missing provider filter is a cross-provider data leak — a standing rule). New tables carry the
right RLS policy in `programmables.sql`.

### 4. Untrusted BYO-IaC sandbox — the customer-OpenTofu boundary
Customer IaC is untrusted code. Check: the runner clones at the **pinned `commit_sha`, never the moving
`ref`** (TOCTOU); the inline `iacsafety` gate runs **fail-closed** before any plan/apply (an error-severity
finding blocks); repo URLs are https/ssh only (`file://` rejected outside the in-package test escape); tofu
state goes to the **HTTP state proxy, never local disk**; the `alethia_*` tfvar namespace can't be injected by
customer var values; module path resolution is traversal- + symlink-guarded.

### 5. Secret handling
Check: secrets flow through `integration_credentials` (or the runtime git/cloud-token handlers), **not**
persisted plaintext. Known gap (W4): add-on config persists admin passwords/tokens as **plaintext JSONB**
(`project_addons.values`/`values_yaml`) — any new secret-bearing config must use a typed secret path, not this
JSONB. No secret in the config_snapshot (it's Postgres-persisted).

### 6. Open-core ee/ boundary
Check: no file **outside** `ee/` imports from `ee/` (CI guards this — don't regress it). The license
entitlement must be a real signed-JWT check, not the `ALETHIA_LICENSE_ACTIVE` env placeholder
(`ee/src/index.ts` — this is a known open item; new ee-gated features must gate on the real entitlement, not
the env flag).

### 7. Runner — mint-bind, scoping, signed evidence
Check: minted tokens are bound to the job/cluster they were issued for (mint-bind), scoped least-privilege
(the connector role enumeration bounds this); the ed25519 evidence receipt is signed over the real plan hash
and verifies; the elench `verify` gate stays **fail-closed** — a hard control failure blocks a real apply
unless an authorized `verify.Override` waives it.

## Output

A short report: one finding per real issue (seam · file:line · failure scenario · fix), most-severe first;
empty if the change is clean. Never invent findings to look thorough — a clean pass on an out-of-scope diff is
the correct result. If the change touches a seam you can't fully evaluate from the diff, say so and name what
you'd need to check.
