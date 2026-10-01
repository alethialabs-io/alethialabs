# E2E fixture repositories

The nightly (`.github/workflows/e2e-nightly.yml`) reads Git repositories that live **outside this
monorepo**. Nothing in this repo can see a path inside them, so this page is the one place that says
which repository each scenario reads, what writes to it, and the exact line that binds it.

Line numbers are as of the commit that added this page. They drift; the variable and constant names
do not, so grep for those.

## The private fixtures (CI-owned — do not edit by hand)

| Repository | Read by | Written by | Bound by | Default when the var is unset |
|---|---|---|---|---|
| `alethialabs-io/alethia-e2e-apps` | A0.6 (ArgoCD-with-repos): the provisioned ArgoCD's `apps` Application syncs its root | Nobody at run time. Its single root `configmap.yaml` is what makes the proof non-vacuous — an empty apps repo reports Healthy+Synced | var `E2E_ARGO_APPS_REPO` → `ALETHIA_E2E_ARGO_APPS_REPO`, `e2e-nightly.yml:1707`; per-cloud `E2E_ARGO_APPS_REPO_GCP` / `_AZURE`, `:1725` / `:1728`; read in `test/e2e/t2_argo_repos.go:83` and `:136` | none — unset ⇒ the A0.6 layer skips |
| `alethialabs-io/alethia-e2e-chart` | A0.6: installed as a bring-your-own Helm chart (`chart/`, ref `HEAD`, namespace `byo-e2e`) | Nobody at run time | var `E2E_ARGO_BYO_CHART_REPO` → `ALETHIA_E2E_ARGO_BYO_CHART_REPO`, `e2e-nightly.yml:1708` (path / revision / namespace `:1709`–`:1711`); per-cloud `E2E_ARGO_BYO_CHART_REPO_GCP` / `_AZURE`, `:1726` / `:1729`; read in `test/e2e/t2_argo_repos.go:84` and `:137`–`:140` | none — unset ⇒ the A0.6 layer skips |
| `alethialabs-io/alethia-e2e-keyless-apps-aws` | keyless-DB scenario, aws leg: the product renders the keyless workload into it | **The harness** force-pushes a README-only orphan commit over the default branch before every run (`keylessAppsRepoReset`, `test/e2e/t2_keyless_db.go:528`); **the product** then pushes rendered manifests | var `E2E_KEYLESS_APPS_REPO_PREFIX` → `ALETHIA_E2E_KEYLESS_APPS_REPO_PREFIX`, `e2e-nightly.yml:1948`; read in `test/e2e/t2_keyless_db.go:90`–`:97` | `https://github.com/alethialabs-io/alethia-e2e-keyless-apps` + `-aws` |
| `alethialabs-io/alethia-e2e-keyless-apps-gcp` | keyless-DB scenario, gcp leg | as above | as above | prefix + `-gcp` |
| `alethialabs-io/alethia-e2e-keyless-apps-azure` | keyless-DB scenario, azure leg | as above | as above | prefix + `-azure` |

All five are **private** on purpose, and all five are reached with the one secret `E2E_GIT_TOKEN`
(→ `ALETHIA_E2E_GIT_TOKEN`, `e2e-nightly.yml:1716`; also passed to the proof-bundle and runner-log
scrubs at `:2370` and `:2531` so the token is in the redaction list). It needs **read** on
`alethia-e2e-apps` and `alethia-e2e-chart`, and **write** (`Contents: write`, force-push allowed on
the default branch) on the three keyless repos. A private fixture is what makes the credentialed
clone load-bearing: a public repo clones whether or not the credential works.

### The keyless names are composed, not written

**A literal grep for `alethia-e2e-keyless-apps-aws` (or `-gcp`, `-azure`) cannot find the code
that binds them.** `keylessAppsRepoFor` (`test/e2e/t2_keyless_db.go:95`) builds each name at run time
as `<prefix>-<provider>`, from the default prefix at `:91` or the var. The full names appear only in
prose — the comment at `e2e-nightly.yml:1946` and [e2e-nightly-enablement.md](./e2e-nightly-enablement.md)
— and as a local bare-repo name inside a unit test (`test/e2e/t2_keyless_db_pure_test.go`), which
touches no real repository. Grep for `KEYLESS_APPS_REPO_PREFIX` or `keylessAppsRepoFor` instead.

The reset refuses any repository whose name does not contain `keyless` and end in `-<provider>`, and
any repository configured as an A0.6 apps repo (`keylessAppsRepoSafeToReset`,
`test/e2e/t2_keyless_db.go:492`). A prefix override must keep that shape.

## The public repositories CI also reads

These are public templates, cloned **anonymously** — no token is served to the scenarios that read
them.

| Repository | Read by | Bound by | Default when the var is unset |
|---|---|---|---|
| `alethialabs-io/alethia-examples` | fabric demo (#845): Online Boutique overlays under `examples/online-boutique/overlays/` | var `E2E_FABRIC_DEMO_REPO` → `ALETHIA_E2E_FABRIC_DEMO_REPO`, `e2e-nightly.yml:1795`; read in `test/e2e/t2_fabric_demo.go:112`, default `:122` | `https://github.com/alethialabs-io/alethia-examples` |
| `alethialabs-io/alethia-examples` | BYO-IaC custody chain: OpenTofu modules at `iac/drift/<provider>` and `iac/blocked` | var `E2E_BYO_IAC_REPO` → `ALETHIA_E2E_BYO_IAC_REPO`, `e2e-nightly.yml:1841`; read in `test/e2e/t2_byo_iac.go:76`, default `:89` | `https://github.com/alethialabs-io/alethia-examples` |
| `alethia-starter-apps`, `alethia-starter-chart`, `alethia-starter-ai` | the `templates` dimension (#4113, hetzner only) | no var — constants in `test/e2e/t2_templates.go:98`–`:100`; the token is withheld on this dimension (`e2e-nightly.yml:1716`) | — |

`alethia-examples` was called `enterprise-demo` before it was renamed. Comments and recorded proof
output that predate the rename still use the old name.

## The README each private fixture should carry

The fixtures are CI-owned, so these are recorded here rather than pushed.

**`alethia-e2e-apps`** — not pushed. The `apps` Application syncs that root and the proof requires
it to manage at least one resource, so the root stays as the one marker manifest the run was proven
against. The text it would carry:

> # alethia-e2e-apps
>
> E2E fixture (CI-owned, do not edit). The apps-destination repository for Alethia's nightly A0.6
> proof (`E2E_ARGO_APPS_REPO`). The provisioned ArgoCD's `apps` Application syncs this root. The
> single `configmap.yaml` exists because an empty apps repo reports Healthy+Synced while managing
> nothing, and the proof fails a repo with no resource in it. It is a ConfigMap, not a Namespace,
> because a cluster-scoped resource would be refused by the default-deny project. Private so the
> credentialed clone (`E2E_GIT_TOKEN`) is load-bearing. Map: `docs/testing/e2e-fixture-repos.md`
> in `alethialabs-io/alethialabs`.

**`alethia-e2e-chart`** already carries a README that matches what this page says: why it is
private, the `chart/` layout matching the harness defaults (`chart`, `HEAD`, `byo-e2e` in
`test/e2e/t2_argo_repos.go`), and why the workload is one `pause` Deployment rather than a
ConfigMap. The one line it lacks is the pointer back here:

> E2E fixture (CI-owned, do not edit). Map: `docs/testing/e2e-fixture-repos.md` in
> `alethialabs-io/alethialabs`.

**`alethia-e2e-keyless-apps-*`** need nothing. The harness writes their only README on every reset
(`keylessAppsRepoREADME`, `test/e2e/t2_keyless_db.go:511`), so anything committed by hand is erased.
