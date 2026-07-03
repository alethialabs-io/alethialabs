// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package infracost

import (
	"math"
	"testing"
)

// TestParseFloat_Table exercises parseFloat across signs, scientific notation,
// whitespace, and the special Inf/NaN tokens that strconv.ParseFloat accepts.
func TestParseFloat_Table(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  float64
	}{
		{"zero", "0", 0},
		{"zero decimal", "0.0", 0},
		{"plain decimal", "142.50", 142.50},
		{"negative", "-12.5", -12.5},
		{"explicit plus", "+3.25", 3.25},
		{"scientific lower", "1e3", 1000},
		{"scientific upper", "1.5E2", 150},
		{"negative scientific", "-2e-1", -0.2},
		{"empty", "", 0},
		{"garbage", "not-a-number", 0},
		{"trailing space rejected", "1.5 ", 0},
		{"leading space rejected", " 1.5", 0},
		{"currency symbol rejected", "$1.50", 0},
		{"comma rejected", "1,000", 0},
		{"positive infinity", "Inf", math.Inf(1)},
		{"negative infinity", "-Inf", math.Inf(-1)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseFloat(tt.input)
			if got != tt.want {
				t.Errorf("parseFloat(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

// TestParseFloat_NaN verifies that the literal "NaN" parses to a NaN value
// (which must be compared with math.IsNaN since NaN != NaN).
func TestParseFloat_NaN(t *testing.T) {
	got := parseFloat("NaN")
	if !math.IsNaN(got) {
		t.Errorf("parseFloat(%q) = %v, want NaN", "NaN", got)
	}
}

// res is a small helper to build a CostResource with only a monthly cost set.
func res(monthly string) CostResource {
	return CostResource{MonthlyCost: monthly}
}

// proj wraps the given resources in a single CostProject.
func proj(resources ...CostResource) CostProject {
	return CostProject{Breakdown: ProjectBreakdown{Resources: resources}}
}

// TestComputeSummary_Table drives computeSummary directly, covering totals
// parsing, multi-project resource aggregation, and the cost > 0 classification
// (so zero, empty, and negative costs all count as "free").
func TestComputeSummary_Table(t *testing.T) {
	tests := []struct {
		name string
		in   *CostBreakdown
		want CostSummary
	}{
		{
			name: "empty breakdown",
			in:   &CostBreakdown{},
			want: CostSummary{},
		},
		{
			name: "totals parsed, no resources",
			in: &CostBreakdown{
				TotalMonthlyCost:     "142.50",
				TotalHourlyCost:      "0.195",
				DiffTotalMonthlyCost: "142.50",
			},
			want: CostSummary{
				TotalMonthly: 142.50,
				TotalHourly:  0.195,
				DiffMonthly:  142.50,
			},
		},
		{
			name: "negative diff (cost reduction)",
			in: &CostBreakdown{
				TotalMonthlyCost:     "50.00",
				DiffTotalMonthlyCost: "-92.50",
			},
			want: CostSummary{
				TotalMonthly: 50.0,
				DiffMonthly:  -92.50,
			},
		},
		{
			name: "mixed resources single project",
			in: &CostBreakdown{
				Projects: []CostProject{
					proj(res("73.00"), res("69.50"), res("0")),
				},
			},
			want: CostSummary{
				ResourcesWithCost: 2,
				ResourcesFree:     1,
				TotalResources:    3,
			},
		},
		{
			name: "empty and negative costs count as free",
			in: &CostBreakdown{
				Projects: []CostProject{
					proj(res(""), res("-5.00"), res("0.0001"), res("invalid")),
				},
			},
			want: CostSummary{
				ResourcesWithCost: 1, // only 0.0001 > 0
				ResourcesFree:     3, // "", "-5.00", "invalid"
				TotalResources:    4,
			},
		},
		{
			name: "resources aggregate across multiple projects",
			in: &CostBreakdown{
				Projects: []CostProject{
					proj(res("10.00"), res("0")),
					proj(res("20.00")),
					proj(), // project with no resources
				},
			},
			want: CostSummary{
				ResourcesWithCost: 2,
				ResourcesFree:     1,
				TotalResources:    3,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := computeSummary(tt.in)
			if got == nil {
				t.Fatal("computeSummary returned nil")
			}
			if got.TotalMonthly != tt.want.TotalMonthly {
				t.Errorf("TotalMonthly = %v, want %v", got.TotalMonthly, tt.want.TotalMonthly)
			}
			if got.TotalHourly != tt.want.TotalHourly {
				t.Errorf("TotalHourly = %v, want %v", got.TotalHourly, tt.want.TotalHourly)
			}
			if got.DiffMonthly != tt.want.DiffMonthly {
				t.Errorf("DiffMonthly = %v, want %v", got.DiffMonthly, tt.want.DiffMonthly)
			}
			if got.ResourcesWithCost != tt.want.ResourcesWithCost {
				t.Errorf("ResourcesWithCost = %d, want %d", got.ResourcesWithCost, tt.want.ResourcesWithCost)
			}
			if got.ResourcesFree != tt.want.ResourcesFree {
				t.Errorf("ResourcesFree = %d, want %d", got.ResourcesFree, tt.want.ResourcesFree)
			}
			if got.TotalResources != tt.want.TotalResources {
				t.Errorf("TotalResources = %d, want %d", got.TotalResources, tt.want.TotalResources)
			}
		})
	}
}

// TestParseCostBreakdown_Table covers ParseCostBreakdown end-to-end for varied
// JSON inputs: an empty document, multi-project aggregation, and malformed input.
func TestParseCostBreakdown_Table(t *testing.T) {
	tests := []struct {
		name              string
		data              string
		wantErr           bool
		wantTotalMonthly  float64
		wantTotalResource int
		wantWithCost      int
		wantFree          int
	}{
		{
			name:    "empty object yields zeroed summary",
			data:    `{}`,
			wantErr: false,
		},
		{
			name:              "multi project aggregation",
			data:              `{"totalMonthlyCost":"30.00","projects":[{"name":"a","breakdown":{"resources":[{"name":"r1","monthlyCost":"10.00"},{"name":"r2","monthlyCost":"0"}]}},{"name":"b","breakdown":{"resources":[{"name":"r3","monthlyCost":"20.00"}]}}]}`,
			wantErr:           false,
			wantTotalMonthly:  30.0,
			wantTotalResource: 3,
			wantWithCost:      2,
			wantFree:          1,
		},
		{
			name:    "malformed json",
			data:    `{"totalMonthlyCost":`,
			wantErr: true,
		},
		{
			name:    "non-object json",
			data:    `[]`,
			wantErr: true,
		},
		{
			name:    "empty bytes",
			data:    ``,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseCostBreakdown([]byte(tt.data))
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Summary == nil {
				t.Fatal("expected non-nil summary")
			}
			if got.Summary.TotalMonthly != tt.wantTotalMonthly {
				t.Errorf("TotalMonthly = %v, want %v", got.Summary.TotalMonthly, tt.wantTotalMonthly)
			}
			if got.Summary.TotalResources != tt.wantTotalResource {
				t.Errorf("TotalResources = %d, want %d", got.Summary.TotalResources, tt.wantTotalResource)
			}
			if got.Summary.ResourcesWithCost != tt.wantWithCost {
				t.Errorf("ResourcesWithCost = %d, want %d", got.Summary.ResourcesWithCost, tt.wantWithCost)
			}
			if got.Summary.ResourcesFree != tt.wantFree {
				t.Errorf("ResourcesFree = %d, want %d", got.Summary.ResourcesFree, tt.wantFree)
			}
		})
	}
}
