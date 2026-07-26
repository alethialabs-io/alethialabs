// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/compat"
)

// buildCompatOverride converts a DEPLOY job's `compat_override` JSON payload into a
// compat.Override the provisioner's version-compatibility gate understands. Mirrors
// buildVerifyOverride 1:1: returns nil when there is no waiver or it carries no
// controls (so the gate stays fail-closed by default). Authorization is the console's
// job (it sets `by` to the actor and persists the row only for principals allowed to
// deploy) — the runner just honours what was recorded.
func buildCompatOverride(raw map[string]any) *compat.Override {
	if len(raw) == 0 {
		return nil
	}
	controls := toStringSlice(raw["controls"])
	if len(controls) == 0 {
		return nil
	}
	ov := &compat.Override{
		Controls: controls,
		Reason:   asString(raw["reason"]),
		By:       asString(raw["by"]),
	}
	if exp := asString(raw["expiry"]); exp != "" {
		if t, err := time.Parse(time.RFC3339, exp); err == nil {
			ov.Expiry = t
		}
	}
	return ov
}
