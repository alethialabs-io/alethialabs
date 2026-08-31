// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// hetznerLBCaptureBasename is the file scripts/e2e/hcloud-cleanup.sh reads the captured binding
// back from, under $RUNNER_TEMP.
//
// ⚠️ A FIXED PATH, not an environment variable set by the test, and that is not a shortcut. The
// sweeper runs in a DIFFERENT PROCESS — the workflow's always() teardown step, long after the test
// has exited — so anything that process exports is invisible to it. The workflow points
// ALETHIA_E2E_HCLOUD_LB_IDS at the same path (e2e-nightly.yml, both teardown steps).
//
// ⚠️ AND IT LIVES HERE, UNTAGGED, ON PURPOSE. The writer is behind `e2e_t2`, so a guard sitting
// beside it would only ever run on a paid nightly — which is precisely when finding out that the
// two ends disagree is too late and too expensive. hetzner_lb_capture_pure_test.go asserts the
// agreement offline, on every PR.
const hetznerLBCaptureBasename = "hcloud-lb-ids.txt"
