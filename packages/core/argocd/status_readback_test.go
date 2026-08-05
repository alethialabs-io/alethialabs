// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"io"
	"reflect"
	"testing"
)

// appListJSON is a two-Application `kubectl get applications -o json` payload.
const appListJSON = `{"items":[
 {"metadata":{"name":"addon-cnpg"},"status":{"health":{"status":"Healthy"},"sync":{"status":"Synced"}}},
 {"metadata":{"name":"addon-valkey"},"status":{"health":{"status":"Degraded"},"sync":{"status":"OutOfSync"}}},
 {"metadata":{"name":"addon-other"},"status":{"health":{"status":"Healthy"},"sync":{"status":"Synced"}}}
]}`

// TestReadAddOnHealth covers the read-back's best-effort contract: names not present in the cluster
// (and every name when the read or the parse fails) come back Unknown/Unknown rather than an error.
func TestReadAddOnHealth(t *testing.T) {
	tests := []struct {
		name       string
		names      []string
		stdout     string
		exit       int
		want       map[string]AddOnHealth
		wantCalled bool
	}{
		{
			name:  "no names short-circuits before kubectl",
			names: nil,
			want:  map[string]AddOnHealth{},
		},
		{
			name:   "matched applications carry their status, unmatched stay Unknown",
			names:  []string{"addon-cnpg", "addon-valkey", "addon-absent"},
			stdout: appListJSON,
			want: map[string]AddOnHealth{
				"addon-cnpg":   {Health: "Healthy", Sync: "Synced"},
				"addon-valkey": {Health: "Degraded", Sync: "OutOfSync"},
				"addon-absent": {Health: "Unknown", Sync: "Unknown"},
			},
			wantCalled: true,
		},
		{
			name:       "a kubectl failure degrades to Unknown, never an error",
			names:      []string{"addon-cnpg"},
			exit:       1,
			want:       map[string]AddOnHealth{"addon-cnpg": {Health: "Unknown", Sync: "Unknown"}},
			wantCalled: true,
		},
		{
			name:       "unparseable JSON degrades to Unknown",
			names:      []string{"addon-cnpg"},
			stdout:     "not json",
			want:       map[string]AddOnHealth{"addon-cnpg": {Health: "Unknown", Sync: "Unknown"}},
			wantCalled: true,
		},
		{
			name:       "an empty status string normalises to Unknown",
			names:      []string{"addon-blank"},
			stdout:     `{"items":[{"metadata":{"name":"addon-blank"},"status":{}}]}`,
			want:       map[string]AddOnHealth{"addon-blank": {Health: "Unknown", Sync: "Unknown"}},
			wantCalled: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			stub := newKubectlStub(t, tc.exit, stubRule{Match: "get applications.argoproj.io", Stdout: tc.stdout, Exit: tc.exit})
			got := ReadAddOnHealth(tc.names, io.Discard, io.Discard)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("ReadAddOnHealth() = %#v, want %#v", got, tc.want)
			}
			if called := stub.calledWith("get applications.argoproj.io"); called != tc.wantCalled {
				t.Errorf("kubectl called = %v, want %v (calls: %v)", called, tc.wantCalled, stub.calls())
			}
		})
	}
}

// TestReadSecurityPosture covers the aggregation and the two honest "not scanned" degradations —
// a missing CRD (kubectl exits non-zero) and an unparseable payload must never report an all-clear.
func TestReadSecurityPosture(t *testing.T) {
	tests := []struct {
		name   string
		stdout string
		exit   int
		want   SecurityPosture
	}{
		{
			name: "sums every report",
			stdout: `{"items":[
			 {"report":{"summary":{"criticalCount":1,"highCount":2,"mediumCount":3,"lowCount":4}}},
			 {"report":{"summary":{"criticalCount":5,"highCount":0,"mediumCount":0,"lowCount":1}}}
			]}`,
			want: SecurityPosture{Critical: 6, High: 2, Medium: 3, Low: 5, ReportCount: 2, Scanned: true},
		},
		{
			name:   "no reports yet is scanned-but-empty",
			stdout: `{"items":[]}`,
			want:   SecurityPosture{Scanned: true},
		},
		{
			name: "the CRD is absent (kubectl fails) - not scanned",
			exit: 1,
			want: SecurityPosture{Scanned: false},
		},
		{
			name:   "unparseable payload - not scanned",
			stdout: "<html>",
			want:   SecurityPosture{Scanned: false},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			newKubectlStub(t, tc.exit, stubRule{Match: "get vulnerabilityreports", Stdout: tc.stdout, Exit: tc.exit})
			got := ReadSecurityPosture(io.Discard, io.Discard)
			if got != tc.want {
				t.Errorf("ReadSecurityPosture() = %#v, want %#v", got, tc.want)
			}
		})
	}
}

// TestReadAppsStatus covers the kubectl-facing wrapper around parseAppsStatus: a read failure and a
// parse failure both yield Unknown aggregates and a NIL services map (the caller's "unreadable"
// signal), while a good read carries the revision and the per-workload rows.
func TestReadAppsStatus(t *testing.T) {
	const good = `{"status":{
	  "health":{"status":"Healthy"},
	  "sync":{"status":"Synced","revision":"abc123"},
	  "resources":[
	    {"kind":"Deployment","name":"api","status":"Synced","health":{"status":"Progressing","message":"rolling"}},
	    {"kind":"Service","name":"api-svc","status":"Synced","health":{"status":"Healthy"}}
	  ]}}`

	tests := []struct {
		name         string
		stdout       string
		exit         int
		wantAgg      AddOnHealth
		wantRevision string
		wantServices map[string]ServiceHealth
	}{
		{
			name:         "workload resources only, revision carried",
			stdout:       good,
			wantAgg:      AddOnHealth{Health: "Healthy", Sync: "Synced"},
			wantRevision: "abc123",
			wantServices: map[string]ServiceHealth{
				"api": {Health: "Progressing", Sync: "Synced", Message: "rolling"},
			},
		},
		{
			name:         "kubectl failure is an honest unknown with a nil services map",
			exit:         1,
			wantAgg:      AddOnHealth{Health: "Unknown", Sync: "Unknown"},
			wantServices: nil,
		},
		{
			name:         "parse failure is an honest unknown with a nil services map",
			stdout:       "{{{",
			wantAgg:      AddOnHealth{Health: "Unknown", Sync: "Unknown"},
			wantServices: nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			newKubectlStub(t, tc.exit, stubRule{Match: "get applications.argoproj.io", Stdout: tc.stdout, Exit: tc.exit})
			agg, rev, svcs := ReadAppsStatus(UserAppsApplicationName, io.Discard, io.Discard)
			if agg != tc.wantAgg {
				t.Errorf("aggregate = %#v, want %#v", agg, tc.wantAgg)
			}
			if rev != tc.wantRevision {
				t.Errorf("revision = %q, want %q", rev, tc.wantRevision)
			}
			if !reflect.DeepEqual(svcs, tc.wantServices) {
				t.Errorf("services = %#v, want %#v", svcs, tc.wantServices)
			}
		})
	}
}
