// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

// RunnerCapabilitiesHeader is the request header on which a runner tells the console which
// config_snapshot shapes it can decode: a comma-separated list of the capability names below. A
// runner that predates it sends no header at all, and is served exactly the snapshot it always was.
//
// WHY A RUNNER MUST SAY SO. The runner decodes config_snapshot STRICTLY (assertNoUnknownSnapshotKeys,
// #1973) — down into addons[] — so a key it has no field for fails the job outright. The console
// therefore emits a new snapshot key only to a runner that advertises the capability naming it, and
// strips it from the snapshot it serves to any other (apps/console/lib/runners/snapshot-capabilities.ts,
// applied at claim time — the stored snapshot, and its signature, are unchanged).
const RunnerCapabilitiesHeader = "X-Runner-Capabilities"

// RunnerCapabilityAddonByoMarker: the runner reads AddOnInstall.Byo (`addons[].byo`, #6445). Without
// it the console serves no `byo` key, and an OCI BYO chart is handled as it was before the marker.
const RunnerCapabilityAddonByoMarker = "addon-byo-marker"

// RunnerCapabilityPreviewNamespacePrefix: the runner reads ProjectConfig.PreviewNamespacePrefix (the
// top-level `preview_namespace_prefix`, #6494). Without it the console serves no such key. Stripping
// is safe because the key only feeds a Deploy-tab warning about a BYO chart in a preview namespace
// (provisioner.byoPreviewOverlap): an older runner deploys exactly as it did, minus that warning.
const RunnerCapabilityPreviewNamespacePrefix = "preview-namespace-prefix"

// RunnerCapabilityPlacementHostNamespaces: the runner reads ProjectConfig.PlacementHostNamespaces (the
// top-level `placement_host_namespaces`, #6551). Without it the console serves no such key. A runner
// that reads it REFUSES a namespace deploy whose snapshot lacks it; an older runner never checked a
// placement namespace against the host, so stripping leaves it deploying exactly as it did.
const RunnerCapabilityPlacementHostNamespaces = "placement-host-namespaces"

// RunnerCapabilityByoAdmission: the runner reads ProjectConfig.ByoAdmission (the top-level
// `byo_admission`, #6541). Without it the console serves no such key. Stripping is safe: an older
// runner decides a BYO namespace's admission mode from whether the namespace exists, as it always
// did, and does not apply the environment's enforce setting. The setting's dialog says so, and the
// Deploy tab shows the mode each namespace actually got, so the difference is visible.
const RunnerCapabilityByoAdmission = "byo-admission"

// RunnerSnapshotCapabilities is every capability this build advertises.
var RunnerSnapshotCapabilities = []string{RunnerCapabilityAddonByoMarker, RunnerCapabilityPreviewNamespacePrefix, RunnerCapabilityPlacementHostNamespaces, RunnerCapabilityByoAdmission}
