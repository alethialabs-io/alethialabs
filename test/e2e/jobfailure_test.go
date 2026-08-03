// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"strings"
	"testing"
)

// TestFormatJobFailure pins the defensive contract: every input shape — including the malformed
// ones — must produce a NON-EMPTY, LABELLED block and never panic. This runs inside a test failure
// report, so a panic here would replace the real cause with its own stack.
func TestFormatJobFailure(t *testing.T) {
	tests := []struct {
		name   string
		errMsg string
		meta   []byte
		want   []string
	}{
		{
			name:   "nil metadata is labelled, not silent",
			errMsg: "boom",
			meta:   nil,
			want:   []string{"error_message: boom", "execution_metadata: (absent"},
		},
		{
			name:   "empty error message is labelled",
			errMsg: "   ",
			meta:   []byte(`{}`),
			want:   []string{"error_message: (empty", "gitops_status: (absent"},
		},
		{
			name:   "undecodable metadata reports itself",
			errMsg: "boom",
			meta:   []byte(`{ not json`),
			want:   []string{"execution_metadata: (undecodable"},
		},
		{
			name:   "gitops_status without a failed step still renders every field",
			errMsg: "boom",
			meta:   []byte(`{"gitops_status":{"mode":"direct"}}`),
			want:   []string{"gitops_status.mode:        direct", "gitops_status.failed_step: (none)"},
		},
		{
			name:   "the real #1734 shape names the step",
			errMsg: "ArgoCD install failed: command returned non-zero exit code: exit status 1",
			meta:   []byte(`{"gitops_status":{"mode":"direct","failed_step":"argocd_install","error":"ArgoCD install failed"}}`),
			want: []string{
				"error_message: ArgoCD install failed",
				"gitops_status.failed_step: argocd_install",
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := FormatJobFailure(tc.errMsg, tc.meta)
			if strings.TrimSpace(got) == "" {
				t.Fatal("FormatJobFailure returned nothing — a failure report must always say something")
			}
			for _, want := range tc.want {
				if !strings.Contains(got, want) {
					t.Fatalf("FormatJobFailure missing %q:\n%s", want, got)
				}
			}
		})
	}
}
