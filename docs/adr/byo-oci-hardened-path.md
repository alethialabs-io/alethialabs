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
   `apps/console/lib/validations/byo-charts.ts`, both pinned to one table of cases), in the console
   form, the attach action, and so the CLI, which sends a blank namespace to that action. `default`
   joins `byo_reserved_namespaces.json` as the `platformWorkloads` group, mirrored by the console with
   the existing parity test.

## Migration

### An OCI BYO chart applied by an earlier deploy

Its Application keeps its name (`addon-<id>`), so the next deploy's `kubectl apply` changes it **in
place**: the project becomes `byo-<slug>` and the sync policy becomes prune-off/self-heal-off in the
same object. No reconcile runs with the new project and the old prune setting. `PruneManagedAddOns`
keeps it, because its name is still in the desired list. ArgoCD's resource tracking does not include
the project, so the chart's objects in its destination namespace stay tracked and are not recreated.

What the hardened project does not permit — a cluster-scoped kind, a `ServiceAccount`, `Role` or
`RoleBinding` — is filtered out of the Application's live view by ArgoCD
(`controller/state.go`, `IsLiveResourcePermitted`) and so is never pruned, and a later detach does not
delete it either (`finalizeApplicationDeletion` deletes only permitted objects). Such an object stays
on the cluster; a chart that still declares it fails its sync naming it, the same as a git chart.

### A chart in `default`

A chart whose stored namespace is `default` or empty (which deployed into `default`) is moved by the
runner on every deploy until it is re-attached with a namespace of its own (`configureByoCharts`):

- its namespace becomes `byo-<chart id>`, which the runner creates and lists as the AppProject's
  destination; `default` is no longer listed;
- the Deploy tab shows a warning naming the chart and its new namespace;
- its binding ExternalSecrets are declared in the new namespace and applied there; the binding prune
  (#6436) also looks in `default` and withdraws the ones an earlier deploy applied there. It deletes
  only objects carrying both the binding marker and this environment's owner label, re-checked on the
  object, so nothing of the platform's in `default` is a candidate.

**What the chart created in `default` is left in place, and the warning says so.** Argo's normal prune
cannot be the mechanism: a BYO Application has prune off (#2910), and once `default` leaves the
project's destinations ArgoCD drops those objects from the Application's view altogether, so neither a
sync nor a later detach removes them. The alternative, the runner deleting them itself, would mean the
runner choosing objects to delete in the namespace that holds the platform's own workloads, by a
tracking annotation a chart's own templates can set. Leaving them, and telling the user how to find
them (`argocd.argoproj.io/tracking-id` beginning `addon-<chart id>:`), touches nothing of the platform.

## Tests

`packages/core/argocd/byo_oci_test.go` and `packages/core/provisioner/byo_move_test.go` cover: an OCI
BYO chart rendered under `byo-<slug>` with the BYO sync policy, its namespace validated and listed; a
catalogue OCI chart unchanged; the renderer's refusal; the namespace derivation table; `default`
reserved; the move, its warning, and the bindings following it; the in-place move of an OCI chart's
Application. The console's tests cover the marker, the new default and the refusal of `default`.
