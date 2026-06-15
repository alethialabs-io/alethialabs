// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package infracost

type CostBreakdown struct {
	Version              string        `json:"version"`
	Currency             string        `json:"currency"`
	TotalMonthlyCost     string        `json:"totalMonthlyCost"`
	TotalHourlyCost      string        `json:"totalHourlyCost"`
	PastTotalMonthlyCost string        `json:"pastTotalMonthlyCost"`
	DiffTotalMonthlyCost string        `json:"diffTotalMonthlyCost"`
	TimeGenerated        string        `json:"timeGenerated"`
	Projects             []CostProject `json:"projects"`
	Summary              *CostSummary  `json:"summary,omitempty"`
}

type CostProject struct {
	Name      string           `json:"name"`
	Metadata  map[string]any   `json:"metadata,omitempty"`
	Breakdown ProjectBreakdown `json:"breakdown"`
}

type ProjectBreakdown struct {
	Resources        []CostResource `json:"resources"`
	TotalMonthlyCost string         `json:"totalMonthlyCost"`
	TotalHourlyCost  string         `json:"totalHourlyCost"`
}

type CostResource struct {
	Name           string            `json:"name"`
	ResourceType   string            `json:"resourceType,omitempty"`
	Tags           map[string]string `json:"tags,omitempty"`
	MonthlyCost    string            `json:"monthlyCost"`
	HourlyCost     string            `json:"hourlyCost,omitempty"`
	CostComponents []CostComponent   `json:"costComponents,omitempty"`
	SubResources   []CostResource    `json:"subresources,omitempty"`
}

type CostComponent struct {
	Name            string `json:"name"`
	Unit            string `json:"unit"`
	HourlyQuantity  string `json:"hourlyQuantity,omitempty"`
	MonthlyQuantity string `json:"monthlyQuantity,omitempty"`
	Price           string `json:"price"`
	MonthlyCost     string `json:"monthlyCost"`
	HourlyCost      string `json:"hourlyCost,omitempty"`
}

type CostSummary struct {
	TotalMonthly       float64 `json:"total_monthly"`
	TotalHourly        float64 `json:"total_hourly"`
	DiffMonthly        float64 `json:"diff_monthly"`
	ResourcesWithCost  int     `json:"resources_with_cost"`
	ResourcesFree      int     `json:"resources_free"`
	TotalResources     int     `json:"total_resources"`
}
