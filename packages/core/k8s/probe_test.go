// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import "testing"

func TestCountReadyNodes(t *testing.T) {
	cases := []struct {
		name               string
		raw                string
		wantReady, wantTot int
		wantErr            bool
	}{
		{
			name:      "two ready",
			raw:       `{"items":[{"status":{"conditions":[{"type":"MemoryPressure","status":"False"},{"type":"Ready","status":"True"}]}},{"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}`,
			wantReady: 2, wantTot: 2,
		},
		{
			name:      "one ready one notready",
			raw:       `{"items":[{"status":{"conditions":[{"type":"Ready","status":"True"}]}},{"status":{"conditions":[{"type":"Ready","status":"False"}]}}]}`,
			wantReady: 1, wantTot: 2,
		},
		{
			name:      "zero nodes (karpenter-only)",
			raw:       `{"items":[]}`,
			wantReady: 0, wantTot: 0,
		},
		{
			name:      "node with no Ready condition",
			raw:       `{"items":[{"status":{"conditions":[{"type":"DiskPressure","status":"False"}]}}]}`,
			wantReady: 0, wantTot: 1,
		},
		{
			name:    "garbage",
			raw:     `not json`,
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ready, total, err := CountReadyNodes([]byte(tc.raw))
			if (err != nil) != tc.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, tc.wantErr)
			}
			if tc.wantErr {
				return
			}
			if ready != tc.wantReady || total != tc.wantTot {
				t.Errorf("got ready=%d total=%d, want ready=%d total=%d", ready, total, tc.wantReady, tc.wantTot)
			}
		})
	}
}
