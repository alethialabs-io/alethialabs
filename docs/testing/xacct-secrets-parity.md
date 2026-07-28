# Cross-account keyless secret managers — parity board

Status of epic [#1206](https://github.com/alethialabs-io/alethialabs/issues/1206) (read a secret from
a cloud secret manager in a **different** account, holding no credential) and its proof,
[#1268](https://github.com/alethialabs-io/alethialabs/issues/1268).

Legend: ✅ done · ⏳ in progress · 🚫 blocked, with the reason stated

Run history: [`demos/proofs/xacct-secrets-e2e-log.md`](../../demos/proofs/xacct-secrets-e2e-log.md).
Every run is recorded by `scripts/e2e/secrets-e2e.sh`, including blocked ones.

## Matrix

| | AWS | GCP | Azure | Alibaba |
|---|---|---|---|---|
| Catalog + model (`*-xacct` connector, `KeylessSecretTarget`) | ✅ | ✅ | ✅ | ✅ |
| ESO `ClusterSecretStore` render (`secretstore-<cloud>-xacct`) | ✅ | ✅ | ✅ | ✅ |
| Cluster-side assume leg | ✅ (only cloud that needs one) | n/a | n/a | n/a |
| Customer bootstrap module (`infra/connector/<cloud>/secrets-xacct`) | ✅ | ✅ | ✅ | ✅ |
| **`ExternalSecret` consumption** (a workload actually reads through the store) | ✅ | ✅ | ✅ | ✅ |
| Standing-identity adoption (target-side grant applied once) | ✅ n/a — role name already deterministic | ✅ `external_secrets_service_account_email` | ✅ `external_secrets_identity_name` + `_resource_group` | 🚫 impossible — see below |
| Account-B stack for the nightly | ✅ `infra/aws-secrets-e2e` | 🚫 not written | 🚫 not written | 🚫 not written |
| **In-cluster e2e (real read, value verified)** | ⏳ harness shipped; awaiting enablement from `main` | 🚫 | 🚫 | 🚫 |
| Connector row `active` (console-connectable) | 🚫 `coming_soon` until the e2e is green | 🚫 | 🚫 | 🚫 |
| Security-reviewed | ✅ | ✅ | ✅ | ✅ |

## Why only AWS runs today

All four lanes render a working store. What differs is whether account B's read grant can survive the
cluster being **destroyed and recreated every night** — the grant names the *cluster's* external-secrets
identity, and that identity is per-provision.

**AWS — runnable.** The IRSA role name is deterministic
(`eks-<region-short>-<env>-<project>-secrets-operator`). An exact-ARN trust still cannot work: IAM
resolves a role-ARN principal to that role's unique id (`AROA…`) when the policy is **saved**, so a
recreate breaks it. `infra/aws-secrets-e2e` instead trusts the account principal narrowed by an
`ArnLike` condition on `aws:PrincipalArn`, evaluated per **request**.

**GCP — blocked.** Deleting the GSA rewrites the target-project binding to
`deleted:serviceAccount:…?uid=<old-uid>`; a same-named recreation is a different identity and does not
inherit it. GCP IAM has no principal-pattern condition, so no grant can be written against a per-run
identity. *Unblocked by* `external_secrets_service_account_email` (adopt a standing GSA) — the template
support has landed; the lane turns on once the nightly supplies one.

**Azure — blocked, twice.** The role assignment binds the managed identity's **object id**, regenerated
on every create, so a stable name buys nothing. *Unblocked by*
`external_secrets_identity_name`/`_resource_group`. Independently, cross-*subscription* needs a second
subscription in the same tenant, which is not available today.

**Alibaba — honest exclusion.** ESO's RRSA performs a single `AssumeRoleWithOIDC` with no chaining, so
account B must host a RAM OIDC provider registered against **this cluster's** ACK issuer, fingerprints
included. That is inherently per-cluster; there is no stable form. The alibaba e2e role also grants no
`ram:*` by design, so it could not create one even in account A.

## Known divergence — the nightly's trust shape

The nightly's account-B trust is **pattern-bound** (`aws:PrincipalArn` + `ArnLike`), while the shipped
customer module `infra/connector/aws/secrets-xacct` trusts an **exact role ARN**.

So the nightly proves the ESO **read path** — identity → assume → cross-account read → in-cluster
`Secret` — but not the exact trust-policy shape a customer writes. This is stated rather than papered
over.

It is closed by `scripts/e2e/secrets-e2e.sh aws strict`: a one-shot **manual** run that applies the
shipped module verbatim against a live run's real IRSA ARN and re-runs the same test. Record its
result in the ledger like any other run.

## What the e2e asserts

1. The deploy's own `infra_services` record says `external-secrets-store-xacct` was **installed** — a
   `skipped` decision fails immediately with the runner's reason, before any cluster polling.
2. The `ClusterSecretStore` reaches `Ready`. ESO validates the store's auth here, so a trust or STS
   misconfiguration surfaces with the provider's real message.
3. The **product-rendered** `ExternalSecret` reaches `Ready`. Deliberately not hand-authored — a
   hand-written one would prove ESO works, not that Alethia wires a project secret to the store.
4. The materialized `Secret`'s value matches the canary's **SHA-256**. Without this the test could
   watch an empty Secret appear and call it a pass. Comparing digests is also why the canary never
   enters CI config, job logs or the proof bundle.
5. **Negative control:** the same read from a namespace labelled `alethia.io/placement=namespace` must
   *not* sync and must materialize no Secret — proving the [#1306] store scoping is real, so a placed
   tenant on a shared Fabric cannot reach a foreign account.

## What's left

- [ ] Apply `infra/aws-secrets-e2e` in the target account and set the repo variables
      ([`e2e-nightly-enablement.md`](./e2e-nightly-enablement.md)); dispatch `aws` **from `main`**
      (real applies are main-gated) and record the run.
- [ ] Run `secrets-e2e.sh aws strict` once to close the trust-shape divergence above.
- [ ] Flip the four `*-xacct` catalog rows from `coming_soon` to `active` — **after** a green run, and
      a maintainer's call.
- [ ] GCP lane: stand up a GSA + target-project grant, set `external_secrets_service_account_email`.
- [ ] Azure lane: a second subscription, plus a standing identity.
- [ ] Console: nothing writes `project_secrets.provider` / `provider_config` today
      (`providerConfigFields` in `registry.generated.ts` has zero consumers), so the connector cannot
      be selected from the UI at all. The e2e seeds the snapshot directly and is unaffected, but the
      *product* flow is blocked on this.

[#1306]: https://github.com/alethialabs-io/alethialabs/issues/1306
