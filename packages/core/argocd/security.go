// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// SecurityPosture is the cluster's aggregated vulnerability posture, read from the
// Trivy-Operator VulnerabilityReport CRDs. `Scanned` is false when Trivy-Operator isn't
// installed (the CRD is absent) or has produced no reports yet — so the console shows an
// honest "not scanned" instead of a misleading all-clear. Mirrors the TS `SecurityReport`.
type SecurityPosture struct {
	Critical    int  `json:"critical"`
	High        int  `json:"high"`
	Medium      int  `json:"medium"`
	Low         int  `json:"low"`
	ReportCount int  `json:"report_count"`
	Scanned     bool `json:"scanned"`
}

// trivyReportList is the trimmed shape of `kubectl get vulnerabilityreports -A -o json`.
type trivyReportList struct {
	Items []struct {
		Report struct {
			Summary struct {
				CriticalCount int `json:"criticalCount"`
				HighCount     int `json:"highCount"`
				MediumCount   int `json:"mediumCount"`
				LowCount      int `json:"lowCount"`
			} `json:"summary"`
		} `json:"report"`
	} `json:"items"`
}

// ReadSecurityPosture aggregates the Trivy-Operator VulnerabilityReports across the cluster
// into a single posture. Best-effort: if the CRD isn't installed (Trivy not enabled) or the
// read fails, it returns an unscanned posture (Scanned=false) rather than an error, so a
// missing scanner never fails a deploy. The same probe backs the Evidence Security tab (L9).
func ReadSecurityPosture(stdout, stderr io.Writer) SecurityPosture {
	raw, err := utils.ExecuteCommandWithOutput(
		"kubectl get vulnerabilityreports.aquasecurity.github.io -A -o json",
		".",
		nil,
	)
	if err != nil {
		// Most commonly: the CRD doesn't exist (Trivy-Operator not installed). Not an error.
		fmt.Fprintf(stdout, "Security posture: Trivy-Operator not installed or no reports yet.\n")
		return SecurityPosture{Scanned: false}
	}

	var list trivyReportList
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		fmt.Fprintf(stderr, "Warning: could not parse Trivy reports: %v\n", err)
		return SecurityPosture{Scanned: false}
	}

	posture := SecurityPosture{Scanned: true, ReportCount: len(list.Items)}
	for _, item := range list.Items {
		s := item.Report.Summary
		posture.Critical += s.CriticalCount
		posture.High += s.HighCount
		posture.Medium += s.MediumCount
		posture.Low += s.LowCount
	}
	return posture
}
