// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package infracost

import (
	"testing"
)

const sampleBreakdown = `{
  "version": "0.2",
  "currency": "USD",
  "totalMonthlyCost": "142.50",
  "totalHourlyCost": "0.195",
  "pastTotalMonthlyCost": "0",
  "diffTotalMonthlyCost": "142.50",
  "timeGenerated": "2026-05-31T12:00:00Z",
  "projects": [
    {
      "name": "main",
      "breakdown": {
        "resources": [
          {
            "name": "aws_eks_cluster.main",
            "resourceType": "aws_eks_cluster",
            "monthlyCost": "73.00",
            "hourlyCost": "0.10",
            "costComponents": [
              {
                "name": "EKS cluster",
                "unit": "hours",
                "monthlyQuantity": "730",
                "price": "0.10",
                "monthlyCost": "73.00"
              }
            ]
          },
          {
            "name": "aws_rds_cluster.main",
            "resourceType": "aws_rds_cluster",
            "monthlyCost": "69.50",
            "hourlyCost": "0.095"
          },
          {
            "name": "aws_vpc.main",
            "resourceType": "aws_vpc",
            "monthlyCost": "0",
            "hourlyCost": "0"
          }
        ],
        "totalMonthlyCost": "142.50",
        "totalHourlyCost": "0.195"
      }
    }
  ]
}`

func TestParseCostBreakdown(t *testing.T) {
	breakdown, err := ParseCostBreakdown([]byte(sampleBreakdown))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if breakdown.TotalMonthlyCost != "142.50" {
		t.Errorf("TotalMonthlyCost = %q, want 142.50", breakdown.TotalMonthlyCost)
	}
	if breakdown.Currency != "USD" {
		t.Errorf("Currency = %q, want USD", breakdown.Currency)
	}
	if breakdown.DiffTotalMonthlyCost != "142.50" {
		t.Errorf("DiffTotalMonthlyCost = %q, want 142.50", breakdown.DiffTotalMonthlyCost)
	}
	if len(breakdown.Projects) != 1 {
		t.Fatalf("expected 1 project, got %d", len(breakdown.Projects))
	}
	if len(breakdown.Projects[0].Breakdown.Resources) != 3 {
		t.Errorf("expected 3 resources, got %d", len(breakdown.Projects[0].Breakdown.Resources))
	}
}

func TestParseCostBreakdown_Summary(t *testing.T) {
	breakdown, err := ParseCostBreakdown([]byte(sampleBreakdown))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if breakdown.Summary == nil {
		t.Fatal("expected summary to be computed")
	}
	if breakdown.Summary.TotalMonthly != 142.50 {
		t.Errorf("TotalMonthly = %v, want 142.50", breakdown.Summary.TotalMonthly)
	}
	if breakdown.Summary.TotalHourly != 0.195 {
		t.Errorf("TotalHourly = %v, want 0.195", breakdown.Summary.TotalHourly)
	}
	if breakdown.Summary.DiffMonthly != 142.50 {
		t.Errorf("DiffMonthly = %v, want 142.50", breakdown.Summary.DiffMonthly)
	}
	if breakdown.Summary.ResourcesWithCost != 2 {
		t.Errorf("ResourcesWithCost = %d, want 2", breakdown.Summary.ResourcesWithCost)
	}
	if breakdown.Summary.ResourcesFree != 1 {
		t.Errorf("ResourcesFree = %d, want 1", breakdown.Summary.ResourcesFree)
	}
	if breakdown.Summary.TotalResources != 3 {
		t.Errorf("TotalResources = %d, want 3", breakdown.Summary.TotalResources)
	}
}

func TestParseCostBreakdown_Empty(t *testing.T) {
	data := `{"version":"0.2","currency":"USD","totalMonthlyCost":"0","totalHourlyCost":"0","projects":[]}`
	breakdown, err := ParseCostBreakdown([]byte(data))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if breakdown.Summary == nil {
		t.Fatal("expected summary")
	}
	if breakdown.Summary.TotalResources != 0 {
		t.Errorf("expected 0 resources, got %d", breakdown.Summary.TotalResources)
	}
}

func TestParseCostBreakdown_InvalidJSON(t *testing.T) {
	_, err := ParseCostBreakdown([]byte(`{invalid`))
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestParseCostBreakdown_CostComponents(t *testing.T) {
	breakdown, err := ParseCostBreakdown([]byte(sampleBreakdown))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	eksResource := breakdown.Projects[0].Breakdown.Resources[0]
	if eksResource.ResourceType != "aws_eks_cluster" {
		t.Errorf("ResourceType = %q, want aws_eks_cluster", eksResource.ResourceType)
	}
	if len(eksResource.CostComponents) != 1 {
		t.Fatalf("expected 1 cost component, got %d", len(eksResource.CostComponents))
	}
	if eksResource.CostComponents[0].Name != "EKS cluster" {
		t.Errorf("CostComponent name = %q, want 'EKS cluster'", eksResource.CostComponents[0].Name)
	}
}

func TestParseFloat(t *testing.T) {
	tests := []struct {
		input string
		want  float64
	}{
		{"0", 0},
		{"142.50", 142.50},
		{"", 0},
		{"not-a-number", 0},
	}

	for _, tt := range tests {
		got := parseFloat(tt.input)
		if got != tt.want {
			t.Errorf("parseFloat(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}
