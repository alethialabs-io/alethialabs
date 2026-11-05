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

// RunnerSnapshotCapabilities is every capability this build advertises.
var RunnerSnapshotCapabilities = []string{RunnerCapabilityAddonByoMarker}
