// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure halves of the bootstrap-Job dump. The field paths and the three-way verdict are what can
// silently stop matching, and the cost of finding that out on a real run is a paid run that reports
// nothing — which is exactly how aws/addons run 33249968471 ended.
package e2e

import (
	"strings"
	"testing"
)

const bootstrapJobList = `{"items":[
 {"metadata":{"name":"alethia-bootstrap-vault","namespace":"vault"},
  "status":{"failed":1,"conditions":[{"type":"Failed","status":"True","reason":"BackoffLimitExceeded","message":"Job has reached the specified backoff limit"}]}},
 {"metadata":{"name":"alethia-bootstrap-appdb","namespace":"databases"},
  "status":{"succeeded":1,"conditions":[{"type":"Complete","status":"True"}]}},
 {"metadata":{"name":"alethia-bootstrap-slow","namespace":"vault"},"status":{"active":1}},
 {"metadata":{"name":"alethia-bootstrap-quiet","namespace":"vault"},"status":{}},
 {"metadata":{"name":"some-other-job","namespace":"default"},"status":{"succeeded":1}}
]}`

func TestParseBootstrapJobsFiltersByPrefixAndReadsTheOutcome(t *testing.T) {
	jobs, err := parseBootstrapJobs([]byte(bootstrapJobList))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(jobs) != 4 {
		t.Fatalf("want the four alethia-bootstrap-* Jobs and not `some-other-job`, got %d: %+v", len(jobs), jobs)
	}
	byName := map[string]bootstrapJob{}
	for _, j := range jobs {
		byName[j.Name] = j
	}
	if v := byName["alethia-bootstrap-vault"].Verdict(); !strings.HasPrefix(v, "FAILED") {
		t.Errorf("a failed Job must read as FAILED, got %q", v)
	}
	if v := byName["alethia-bootstrap-appdb"].Verdict(); v != "Complete" {
		t.Errorf("want Complete, got %q", v)
	}
	// THE THIRD AND FOURTH STATES, and they are the reason Verdict is not a boolean. A Job still
	// running is not a Job that failed, and a Job that has reported nothing is neither — reading
	// either as success is how a sealed Vault gets called healthy.
	if v := byName["alethia-bootstrap-slow"].Verdict(); v != "still running" {
		t.Errorf("want 'still running', got %q", v)
	}
	if v := byName["alethia-bootstrap-quiet"].Verdict(); !strings.Contains(v, "has not reported") {
		t.Errorf("a Job with no counts must say so rather than pick one, got %q", v)
	}
	if c := byName["alethia-bootstrap-vault"].Conditions; len(c) != 1 || !strings.Contains(c[0], "BackoffLimitExceeded") {
		t.Errorf("the condition carries the reason and must be kept: %v", c)
	}
}

func TestParseBootstrapJobsFailsLoudlyOnGarbage(t *testing.T) {
	if _, err := parseBootstrapJobs([]byte("not json")); err == nil {
		t.Fatal("unparseable input reported success — the dump would then print 'NONE found', which reads as a finding")
	}
}

// An empty list is a FINDING, not a clean bill of health: either no bootstrap was applied, or the
// TTL collected them first. Both were true at different points on aws/addons run 33249968471.
func TestParseBootstrapJobsOnAClusterWithNone(t *testing.T) {
	jobs, err := parseBootstrapJobs([]byte(`{"items":[{"metadata":{"name":"unrelated","namespace":"x"},"status":{}}]}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(jobs) != 0 {
		t.Fatalf("want none, got %+v", jobs)
	}
}
