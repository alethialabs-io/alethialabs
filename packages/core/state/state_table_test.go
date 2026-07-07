// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package state

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// TestRawConfigFromFullConfig_Table drives the real parser across the full input
// matrix: nil/empty/whitespace/malformed/non-object errors plus valid shapes
// (scalars, nested objects, JSON numbers decoded as float64, empty object).
func TestRawConfigFromFullConfig_Table(t *testing.T) {
	str := func(s string) *string { return &s }
	tests := []struct {
		name    string
		input   *string
		wantErr bool
		// check runs only when wantErr is false.
		check func(t *testing.T, m map[string]interface{})
	}{
		{name: "nil pointer", input: nil, wantErr: true},
		{name: "empty string", input: str(""), wantErr: true},
		{name: "whitespace only", input: str("   "), wantErr: true},
		{name: "malformed json", input: str("{not valid json"), wantErr: true},
		{name: "top-level array not an object", input: str(`[1,2,3]`), wantErr: true},
		{name: "top-level scalar not an object", input: str(`"hello"`), wantErr: true},
		{
			name:  "empty object is valid",
			input: str(`{}`),
			check: func(t *testing.T, m map[string]interface{}) {
				if len(m) != 0 {
					t.Errorf("len = %d, want 0", len(m))
				}
			},
		},
		{
			name:  "scalars and numbers",
			input: str(`{"region":"eu-west-1","count":3,"enabled":true}`),
			check: func(t *testing.T, m map[string]interface{}) {
				if m["region"] != "eu-west-1" {
					t.Errorf("region = %v, want eu-west-1", m["region"])
				}
				// JSON numbers decode to float64.
				if got, ok := m["count"].(float64); !ok || got != 3 {
					t.Errorf("count = %v (%T), want float64(3)", m["count"], m["count"])
				}
				if m["enabled"] != true {
					t.Errorf("enabled = %v, want true", m["enabled"])
				}
			},
		},
		{
			name:  "nested object preserved",
			input: str(`{"vpc":{"cidr":"10.0.0.0/16"}}`),
			check: func(t *testing.T, m map[string]interface{}) {
				nested, ok := m["vpc"].(map[string]interface{})
				if !ok {
					t.Fatalf("vpc = %T, want map[string]interface{}", m["vpc"])
				}
				if nested["cidr"] != "10.0.0.0/16" {
					t.Errorf("vpc.cidr = %v, want 10.0.0.0/16", nested["cidr"])
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := RawConfigFromFullConfig(tt.input)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr = %v", err, tt.wantErr)
			}
			if tt.wantErr {
				if got != nil {
					t.Errorf("got = %v, want nil map on error", got)
				}
				return
			}
			tt.check(t, got)
		})
	}
}

// TestSaveInfraFacts_Table drives the real SaveInfraFacts through its filter/merge
// behaviour: sensitive-field stripping, scalar-only retention (incl. native int),
// output merge, output-over-rawConfig collision precedence, and the dry-run path
// where empty outputs are allowed and produce an empty infra-services map.
func TestSaveInfraFacts_Table(t *testing.T) {
	tests := []struct {
		name    string
		raw     map[string]interface{}
		outputs map[string]interface{}
		dryRun  bool
		wantErr bool
		// want asserts the written infra-services map (only when !wantErr).
		want map[string]interface{}
		// absent keys must NOT appear in the written map.
		absent []string
	}{
		{
			name: "sensitive fields stripped, scalars + outputs merged",
			raw: map[string]interface{}{
				"project_name":                   "test",
				"region":                         "eu-west-1",
				"gitops_argo_access_token":       "secret-token-123",
				"applications_argo_access_token": "another-secret",
			},
			outputs: map[string]interface{}{"cluster_endpoint": "https://x"},
			want: map[string]interface{}{
				"project_name":     "test",
				"region":           "eu-west-1",
				"cluster_endpoint": "https://x",
			},
			absent: []string{"gitops_argo_access_token", "applications_argo_access_token"},
		},
		{
			name: "non-scalar raw values dropped, native int kept",
			raw: map[string]interface{}{
				"project_name": "test",
				"node_count":   42, // native int (not float64)
				"enabled":      true,
				"nested_map":   map[string]interface{}{"key": "val"},
				"slice":        []string{"a", "b"},
			},
			outputs: map[string]interface{}{"out": "v"},
			want: map[string]interface{}{
				"project_name": "test",
				"node_count":   42,
				"enabled":      true,
				"out":          "v",
			},
			absent: []string{"nested_map", "slice"},
		},
		{
			name:    "output overrides colliding rawConfig key",
			raw:     map[string]interface{}{"region": "from-config"},
			outputs: map[string]interface{}{"region": "from-output"},
			want:    map[string]interface{}{"region": "from-output"},
		},
		{
			name:    "dry-run allows empty outputs and writes empty infra-services",
			raw:     map[string]interface{}{},
			outputs: map[string]interface{}{},
			dryRun:  true,
			want:    map[string]interface{}{},
		},
		{
			name:    "dry-run keeps scalars even with no outputs",
			raw:     map[string]interface{}{"project_name": "test"},
			outputs: map[string]interface{}{},
			dryRun:  true,
			want:    map[string]interface{}{"project_name": "test"},
		},
		{
			name:    "non-dry-run with empty outputs errors",
			raw:     map[string]interface{}{"project_name": "test"},
			outputs: map[string]interface{}{},
			dryRun:  false,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.wantErr {
				t.Chdir(t.TempDir())
				err := (&State{}).SaveInfraFacts(tt.raw, tt.outputs, tt.dryRun, utils.NewLogger(nil, ""))
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}

			svc := readInfraServices(t, tt.raw, tt.outputs, tt.dryRun)

			if len(svc) != len(tt.want) {
				t.Errorf("infra-services size = %d, want %d (got %v)", len(svc), len(tt.want), svc)
			}
			for k, want := range tt.want {
				if got := svc[k]; got != want {
					t.Errorf("svc[%q] = %v (%T), want %v (%T)", k, got, got, want, want)
				}
			}
			for _, k := range tt.absent {
				if _, ok := svc[k]; ok {
					t.Errorf("svc[%q] present, want absent", k)
				}
			}
		})
	}
}
