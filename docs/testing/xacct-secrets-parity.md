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
| Adoption reachable from a project (cluster `provider_config` → tofu; the cluster card's Advanced section) | n/a | ✅ | ✅ | n/a |
| Account-B stack for the nightly | ✅ `infra/aws-secrets-e2e` | ✅ `infra/gcp-secrets-e2e` | 🚫 not written | 🚫 not written |
| **In-cluster e2e (real read, value verified)** | ⏳ harness shipped; awaiting enablement from `main` | ⏳ harness shipped (adopts the standing GSA); awaiting enablement from `main` | 🚫 | 🚫 |
| Connector row `active` (console-connectable) | 🚫 `coming_soon` until the e2e is green | 🚫 | 🚫 | 🚫 |
| Security-reviewed | ✅ | ✅ | ✅ | ✅ |

## Why only AWS and GCP can run

All four lanes render a working store. What differs is whether account B's read grant can survive the
cluster being **destroyed and recreated every night** — the grant names the *cluster's* external-secrets
identity, and that identity is per-provision.

**AWS — runnable.** The IRSA role name is deterministic
(`eks-<region-short>-<env>-<project>-secrets-operator`). An exact-ARN trust still cannot work: IAM
resolves a role-ARN principal to that role's unique id (`AROA…`) when the policy is **saved**, so a
recreate breaks it. `infra/aws-secrets-e2e` instead trusts the account principal narrowed by an
`ArnLike` condition on `aws:PrincipalArn`, evaluated per **request**.

**GCP — runnable, against an adopted identity.** Deleting a GSA rewrites the target-project binding
to `deleted:serviceAccount:…?uid=<old-uid>`; a same-named recreation is a different identity and does
not inherit it, and GCP IAM has no principal-pattern condition. So a grant can never be written
against a per-run GSA — only against a **standing** one the cluster adopts through
`external_secrets_service_account_email`. That variable needs no typed field: the cluster
component's `provider_config` passthrough carries it to tofu, and the console offers it in the
cluster card's generated Advanced section. `TestProviderTfvars_StandingIdentityAdoptionIsReachable`
(`packages/core/cloud/passthrough_test.go`) fails if a provider ever reserves the key or the template
renames it. The nightly writes it the same way (`adoptStandingIdentity`,
`test/e2e/t2_secrets_xacct.go`) from `E2E_SECRETS_XACCT_ESO_GSA_EMAIL`, and refuses a gcp run that
sets the account-B project without the GSA, since that run could only be denied. Account B's grant is
`infra/gcp-secrets-e2e`; the standing GSA itself lives in project A and is created out of band.

**Azure — blocked, twice.** The role assignment binds the managed identity's **object id**, regenerated
on every create, so a stable name buys nothing. *Unblocked by*
`external_secrets_identity_name`/`_resource_group`, which reach tofu by the same passthrough as GCP's. Independently, cross-*subscription* needs a second
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
- [ ] GCP lane: create the standing external-secrets GSA in project A, apply `infra/gcp-secrets-e2e`
      in project B against it, set `E2E_SECRETS_XACCT_PROJECT_ID` and `E2E_SECRETS_XACCT_ESO_GSA_EMAIL`
      (plus the shared `_REMOTE_KEY` / `_EXPECT_SHA256`), then dispatch `gcp` **from `main`** and record
      the run. The e2e provisioner must be able to grant `roles/iam.workloadIdentityUser` on that GSA —
      the template writes that binding when it adopts one.
- [ ] Azure lane: a second subscription, plus a standing identity.
- [ ] Console: nothing writes `project_secrets.provider` / `provider_config` today
      (`providerConfigFields` in `registry.generated.ts` has zero consumers), so the connector cannot
      be selected from the UI at all. The e2e seeds the snapshot directly and is unaffected, but the
      *product* flow is blocked on this.

[#1306]: https://github.com/alethialabs-io/alethialabs/issues/1306
