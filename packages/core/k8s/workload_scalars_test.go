// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import "testing"

// TestAsIntCoercesEveryYAMLNumericShape covers every arm of the coercion the workload extractor
// reads replica counts through. yaml.v3 decodes a bare integer as `int`, a large one as `int64` and
// anything with a decimal point as `float64` — so a table missing an arm is a chart whose replicas
// silently read as -1 (absent) rather than the number the customer wrote.
func TestAsIntCoercesEveryYAMLNumericShape(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want int
	}{
		{"int", 3, 3},
		{"int64", int64(9), 9},
		{"float64 whole", float64(4), 4},
		{"float64 truncates toward zero", 2.9, 2},
		{"string is not a number", "3", -1},
		{"absent", nil, -1},
		{"map", map[string]any{}, -1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := asInt(c.in); got != c.want {
				t.Errorf("asInt(%#v) = %d, want %d", c.in, got, c.want)
			}
		})
	}
}

// TestAsScalarRendersQuantitiesFaithfully covers every arm of the quantity coercion. Kubernetes
// quantities normally render as strings ("100m", "128Mi"), but a bare `cpu: 1` decodes as a number,
// and rendering that as "1" rather than "1e+00" or "" is what keeps a described workload's resources
// equal to the chart's.
func TestAsScalarRendersQuantitiesFaithfully(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want string
	}{
		{"string quantity", "128Mi", "128Mi"},
		{"int", 1, "1"},
		{"int64", int64(2), "2"},
		{"float64 with no fraction is not rendered as a float", float64(3), "3"},
		{"float64 with a fraction keeps it, without an exponent", 0.5, "0.5"},
		{"bool is not a quantity", true, ""},
		{"absent", nil, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := asScalar(c.in); got != c.want {
				t.Errorf("asScalar(%#v) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}
