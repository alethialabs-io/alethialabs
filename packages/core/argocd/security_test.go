// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"os"
	"testing"
)

func TestTrivyReportAggregate(t *testing.T) {
	// Two reports across the cluster; the posture sums their severity counts.
	raw := `{"items":[
	  {"report":{"summary":{"criticalCount":1,"highCount":2,"mediumCount":3,"lowCount":4}}},
	  {"report":{"summary":{"criticalCount":0,"highCount":1,"mediumCount":0,"lowCount":5}}}
	]}`
	var list trivyReportList
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		t.Fatal(err)
	}
	posture := SecurityPosture{Scanned: true, ReportCount: len(list.Items)}
	for _, item := range list.Items {
		s := item.Report.Summary
		posture.Critical += s.CriticalCount
		posture.High += s.HighCount
		posture.Medium += s.MediumCount
		posture.Low += s.LowCount
	}
	if posture.Critical != 1 || posture.High != 3 || posture.Medium != 3 || posture.Low != 9 {
		t.Errorf("unexpected aggregate: %+v", posture)
	}
	if posture.ReportCount != 2 {
		t.Errorf("expected 2 reports, got %d", posture.ReportCount)
	}
}

func TestReadSecurityPostureUnscannedWithoutCluster(t *testing.T) {
	// No cluster / CRD reachable → unscanned posture, never an error.
	p := ReadSecurityPosture(os.Stdout, os.Stderr)
	if p.Scanned {
		t.Errorf("expected Scanned=false without a cluster, got %+v", p)
	}
}
