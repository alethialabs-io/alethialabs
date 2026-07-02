// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestJobTypeLabels_CoverAllJobTypes is the map-side counterpart to the exhaustive-linted
// switches: `exhaustive` can enforce `switch` statements but not maps, so this asserts
// every provision_job_type value (generated into types.AllJobTypes from the drizzle enum
// SSOT) has a friendly label. Adding a job type without a label fails the build.
func TestJobTypeLabels_CoverAllJobTypes(t *testing.T) {
	for _, jt := range types.AllJobTypes {
		if jobTypeLabels[string(jt)] == "" {
			t.Errorf("provision_job_type %q has no entry in jobTypeLabels — add one in jobs_list.go", jt)
		}
	}
}
