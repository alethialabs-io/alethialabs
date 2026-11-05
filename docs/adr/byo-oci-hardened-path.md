<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Every BYO chart, git or OCI, deploys under its hardened project into a namespace of its own

**Status:** Accepted (maintainer decision on the namespace default, 2026-11-04) · **Issues:** #6445, #6446 ·
**Follows:** #6436 (binding prune), #6442 (reserved namespaces)

## Property

Every bring-your-own chart — from a git repository or from an OCI registry — is deployed under its
project's hardened `byo-<slug>` AppProject, into a namespace of its own that the runner has validated.
No BYO chart renders under the catalogue's project, and no BYO chart shares `default` with the
platform's own workloads, their Secrets and their service accounts.

## Decision

1. **An explicit marker, not the URL.** The console stamps `byo: true` on every BYO add-on spec
   (`resolveByoChartInstall`, `apps/console/lib/addons/catalog.ts`). An `oci://` URL says where a chart
   is stored, not who wrote it, and catalogue charts can be OCI too, so the scheme is not a signal.
   **The marker reaches a runner only if that runner says it reads it.** A runner decodes
   `config_snapshot` strictly (`assertNoUnknownSnapshotKeys`, #1973, down into `addons[]`), so a runner
   built before the marker would fail every job whose snapshot carries it. A runner now names the keys
   it reads in an `X-Runner-Capabilities` header on every request (`types.RunnerSnapshotCapabilities`;
   this one is `addon-byo-marker`), and the claim route serves `addons[].byo` only to a runner that
   names it (`apps/console/lib/runners/snapshot-capabilities.ts`). Any other runner — every runner
   built before the header — is served the snapshot exactly as before: its OCI BYO charts are handled
   as they were until that runner is updated. The strip is applied to the claim response; the stored
   snapshot and its signature are unchanged. Shared fixtures in
   `packages/core/types/testdata/snapshot-capabilities` pin both halves: the console's strip produces
   the second from the first, and the runner's test decodes the second the way an old runner does.
2. **One predicate.** `types.AddOnInstall.IsByo()` is true for the marker and for every git source
   (only BYO charts are git-sourced, and snapshots written before the marker carry git BYO charts
   without it). Every BYO step keys on it: namespace validation and the move below, the pin to
   `byo-<slug>`, the AppProject's `sourceRepos` and `destinations`, the binding lane, and the BYO sync
   policy (auto-sync, prune and self-heal off). A git token is registered only for a git chart's repo;
   an OCI chart's registry credential stays the helm-registry connector's.
3. **Fail closed in the renderer.** `argocd.RenderAddOnApplication` refuses a BYO add-on whose project
   is not a `byo-` project, instead of defaulting it to the catalogue's project.
4. **A namespace of its own.** A new chart's namespace defaults to `byo-<chart id>`
   (`argocd.ByoChartNamespace`, mirrored by `byoChartNamespace` in
   `apps/console/lib/validations/byo-charts.ts`, both pinned to one table of literal cases), in the
   console form, the attach action, and so the CLI, which sends a blank namespace to that action. A
   name past 63 characters is cut and ends in an 8-hex FNV-1a hash of the whole id, so two ids never
   share a derived namespace. `default` joins `byo_reserved_namespaces.json` as the `platformWorkloads`
   group, mirrored by the console with the existing parity test.
5. **`byo-` is reserved for derived namespaces.** A namespace a chart chooses may start with `byo-`
   only when it is that chart's own derived one (`argocd.ValidateByoChartNamespace`; the console's
   attach action and form refuse it too). So no chart can be given — or choose — another chart's
   namespace.

## Migration

### An OCI BYO chart applied by an earlier deploy

Its Application keeps its name (`addon-<id>`), so the next deploy's `kubectl apply` changes it **in
place**: the project becomes `byo-<slug>` and the sync policy becomes prune-off/self-heal-off in the
same object. That apply is one PATCH, so no reconcile ever reads a spec with the new project and the
old prune setting. An auto-sync operation already running when the patch lands keeps the
`prune: true` it started with and runs to completion; it compares against the live objects the NEW
project permits, so it can prune nothing beyond what the old setting already would have. `PruneManagedAddOns`
keeps it, because its name is still in the desired list. ArgoCD's resource tracking does not include
the project, so the chart's objects in its destination namespace stay tracked and are not recreated.

Before the re-apply the runner reads the live Application's `spec.project`; when it is another project
the Deploy tab says the chart now runs under its hardened project, which kinds will fail its sync, and
that what it created earlier outside that allowance is left in place.

What the hardened project does not permit — a cluster-scoped kind, a `ServiceAccount`, `Role` or
`RoleBinding` — is filtered out of the Application's live view by ArgoCD
(`controller/state.go`, `IsLiveResourcePermitted`) and so is never pruned, and a later detach does not
delete it either (`finalizeApplicationDeletion` deletes only permitted objects). Such an object stays
on the cluster; a chart that still declares it fails its sync naming it, the same as a git chart.

A snapshot stored before the marker existed (a queued job, a promotion's PLAN) carries no marker, so
its OCI BYO chart is handled as before for that one job; the next snapshot the console builds carries it.

### A chart in `default`

A chart whose stored namespace is `default` or empty (which deployed into `default`) is moved by the
runner on every deploy until it is re-attached with a namespace of its own (`configureByoCharts`):

- its namespace becomes `byo-<chart id>`, which the runner creates and lists as the AppProject's
  destination; `default` is no longer listed;
- the Deploy tab shows a warning naming the chart and its new namespace;
- its binding ExternalSecrets are declared in the new namespace and applied there; the binding prune
  (#6436) also looks in `default` and withdraws the ones an earlier deploy applied there. It deletes
  only objects carrying both the binding marker and this environment's owner label, re-checked on the
  object, so nothing of the platform's in `default` is a candidate;
- an earlier runner labelled `default` as a BYO namespace when a chart deployed there
  (`alethia.io/managed-by: byo-charts`, `alethia.io/environment-id`). Once the AppProject no longer
  lists it, those two keys are removed — each only when its value is the one this environment wrote,
  and not at all when the namespace names another environment (`argocd.ReleaseLegacyByoNamespaceLabels`).
  Nothing else on `default` is touched.

**What the chart created in `default` is left in place, and the warning says so** — including that it
keeps running in the platform's namespace until it is deleted. Argo's normal prune
cannot be the mechanism: a BYO Application has prune off (#2910), and once `default` leaves the
project's destinations ArgoCD drops those objects from the Application's view altogether, so neither a
sync nor a later detach removes them. The alternative, the runner deleting them itself, would mean the
runner choosing objects to delete in the namespace that holds the platform's own workloads, by a
tracking annotation a chart's own templates can set. Leaving them, and telling the user how to find
them (`argocd.argoproj.io/tracking-id` beginning `addon-<chart id>:`), touches nothing of the platform.

## Tests

`apps/runner/internal/agent/snapshot_capabilities_test.go` and
`apps/console/tests/lib/runners/snapshot-capabilities.test.ts` (plus the claim route's test) cover the
marker's gate. `packages/core/argocd/byo_oci_test.go` and `packages/core/provisioner/byo_move_test.go` cover: an OCI
BYO chart rendered under `byo-<slug>` with the BYO sync policy, its namespace validated and listed; a
catalogue OCI chart unchanged; the renderer's refusal; the namespace derivation table; `default`
reserved; the move, its warning, and the bindings following it; the in-place move of an OCI chart's
Application. The console's tests cover the marker, the new default and the refusal of `default`.
