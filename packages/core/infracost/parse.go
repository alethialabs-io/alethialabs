// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package infracost

import (
	"encoding/json"
	"fmt"
	"strconv"
)

func ParseCostBreakdown(data []byte) (*CostBreakdown, error) {
	var breakdown CostBreakdown
	if err := json.Unmarshal(data, &breakdown); err != nil {
		return nil, fmt.Errorf("failed to parse infracost JSON: %w", err)
	}

	breakdown.Summary = computeSummary(&breakdown)
	return &breakdown, nil
}

func computeSummary(b *CostBreakdown) *CostSummary {
	s := &CostSummary{}

	s.TotalMonthly = parseFloat(b.TotalMonthlyCost)
	s.TotalHourly = parseFloat(b.TotalHourlyCost)
	s.DiffMonthly = parseFloat(b.DiffTotalMonthlyCost)

	for _, project := range b.Projects {
		for _, resource := range project.Breakdown.Resources {
			s.TotalResources++
			cost := parseFloat(resource.MonthlyCost)
			if cost > 0 {
				s.ResourcesWithCost++
			} else {
				s.ResourcesFree++
			}
		}
	}

	return s
}

func parseFloat(s string) float64 {
	if s == "" {
		return 0
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return f
}
