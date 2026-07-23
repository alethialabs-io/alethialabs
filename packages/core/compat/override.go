// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package compat

import (
	"slices"
	"time"
)

// Override records an authorized, time-boxed waiver of one or more failing
// compatibility controls so the fail-closed apply gate can be passed deliberately
// rather than disabled wholesale. Mirrors verify.Override — the apply-time unit
// (#1215) threads it through the same Unwaived/Override machinery.
type Override struct {
	// Controls is the set of control IDs explicitly waived (e.g. "COMPAT-COMPONENT-ARGOCD").
	Controls []string `json:"controls"`
	// Reason is the human justification.
	Reason string `json:"reason"`
	// By identifies the principal who authorized the waiver.
	By string `json:"by"`
	// Expiry is when the waiver stops applying. A zero value means no expiry.
	Expiry time.Time `json:"expiry"`
}

// Covers reports whether this override currently waives a given control ID.
// Nil-safe on the receiver, and false for an expired waiver.
func (ov *Override) Covers(id string) bool {
	if ov == nil {
		return false
	}
	if !ov.Expiry.IsZero() && time.Now().After(ov.Expiry) {
		return false
	}
	return slices.Contains(ov.Controls, id)
}

// Unwaived returns the IDs of controls that FAILED and are NOT covered by a valid
// override. A non-empty result means the apply must stay blocked.
func (r *Report) Unwaived(ov *Override) []string {
	var out []string
	for _, c := range r.Controls {
		if c.Status != StatusFail {
			continue
		}
		if ov.Covers(c.ID) {
			continue
		}
		out = append(out, c.ID)
	}
	return out
}
