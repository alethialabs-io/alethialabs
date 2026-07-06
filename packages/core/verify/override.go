// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package verify

import (
	"slices"
	"time"
)

// Override records an authorized, time-boxed waiver of one or more failing
// controls so a fail-closed gate can be passed deliberately rather than disabled
// wholesale. Phase 0 threads it through and records it; Phase 1 adds the
// authorization workflow (who may grant it, approval, audit) and seals it into
// the evidence receipt as a recorded exception.
type Override struct {
	// Controls is the set of control IDs explicitly waived (e.g. "LEASTPRIV-001").
	Controls []string `json:"controls"`
	// Reason is the human justification (required by the Phase-1 workflow).
	Reason string `json:"reason"`
	// By identifies the principal who authorized the waiver.
	By string `json:"by"`
	// Expiry is when the waiver stops applying. A zero value means no expiry
	// (discouraged; the Phase-1 workflow requires a bounded expiry).
	Expiry time.Time `json:"expiry"`
}

// covers reports whether this override currently waives a given control ID.
func (ov *Override) covers(id string) bool {
	if ov == nil {
		return false
	}
	if !ov.Expiry.IsZero() && time.Now().After(ov.Expiry) {
		return false
	}
	return slices.Contains(ov.Controls, id)
}

// Unwaived returns the IDs of controls that FAILED and are NOT covered by a
// valid override. A non-empty result means the apply must stay blocked.
func (r *Report) Unwaived(ov *Override) []string {
	var out []string
	for _, c := range r.Controls {
		if c.Status != StatusFail {
			continue
		}
		if ov.covers(c.ID) {
			continue
		}
		out = append(out, c.ID)
	}
	return out
}
