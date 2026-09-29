// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestControlPlane_ServesTheTalosconfigChannel is the regression for #845 run 36626677124: the runner's
// PUT (write-back after the dedicated apply) and GET (fetch before a hetzner placement) of
// /api/jobs/{id}/talosconfig both got the harness mux's 404, so no hetzner placement could reach its
// Fabric. An unauthenticated request must reach the handler and be refused as unauthorized — a 404 or a
// 405 means the route is not served. No database is touched: the handler refuses on the missing
// runner headers before any query.
func TestControlPlane_ServesTheTalosconfigChannel(t *testing.T) {
	h := (&ControlPlane{}).mux()
	for _, method := range []string{http.MethodPut, http.MethodGet} {
		req := httptest.NewRequest(method, "/api/jobs/0b0e8c4e-0000-4000-8000-000000000000/talosconfig", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s /api/jobs/{id}/talosconfig = %d, want 401 (a 404/405 means the harness does not serve the route the runner calls)", method, rec.Code)
		}
	}
}

// TestGateTalosconfigJob pins every refusal of the harness gate against the console route it mirrors.
func TestGateTalosconfigJob(t *testing.T) {
	const runner = "r-1"
	dedicated := []byte(`{"provider":"hetzner"}`)
	placement := []byte(`{"provider":"hetzner","placement_mode":"namespace","cluster":{"cluster_name":"alethia-nl-1"}}`)
	executing := func(snap []byte) *talosJobRow {
		return &talosJobRow{runnerID: runner, jobType: "DEPLOY", status: "PROCESSING", snapshot: snap}
	}
	for _, tc := range []struct {
		name        string
		row         *talosJobRow
		write       bool
		wantCode    int
		wantCluster string
	}{
		{"missing job", nil, false, http.StatusNotFound, ""},
		{"unclaimed job", &talosJobRow{jobType: "DEPLOY", status: "QUEUED", snapshot: dedicated}, true, http.StatusForbidden, ""},
		{"another runner's job", &talosJobRow{runnerID: "r-2", jobType: "DEPLOY", status: "PROCESSING", snapshot: dedicated}, true, http.StatusForbidden, ""},
		{"not a deploy", &talosJobRow{runnerID: runner, jobType: "DESTROY", status: "PROCESSING", snapshot: dedicated}, true, http.StatusForbidden, ""},
		{"finished job", &talosJobRow{runnerID: runner, jobType: "DEPLOY", status: "SUCCESS", snapshot: dedicated}, false, http.StatusForbidden, ""},
		{"not hetzner", executing([]byte(`{"provider":"aws"}`)), true, http.StatusForbidden, ""},
		{"unreadable snapshot", executing([]byte(`not json`)), true, http.StatusConflict, ""},
		{"placement may not write", executing(placement), true, http.StatusForbidden, ""},
		{"vcluster may not write", executing([]byte(`{"provider":"hetzner","placement_mode":"vcluster"}`)), true, http.StatusForbidden, ""},
		{"dedicated writes", executing(dedicated), true, 0, ""},
		{"explicit dedicated writes", executing([]byte(`{"provider":"hetzner","placement_mode":"dedicated"}`)), true, 0, ""},
		{"placement reads its Fabric", executing(placement), false, 0, "alethia-nl-1"},
		{"read with no Fabric cluster", executing([]byte(`{"provider":"hetzner","placement_mode":"namespace"}`)), false, http.StatusConflict, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := gateTalosconfigJob(tc.row, runner, tc.write)
			if got.code != tc.wantCode {
				t.Fatalf("code = %d (%q), want %d", got.code, got.message, tc.wantCode)
			}
			if got.placementCluster != tc.wantCluster {
				t.Errorf("placementCluster = %q, want %q", got.placementCluster, tc.wantCluster)
			}
		})
	}
}

// TestLatestHeldFor proves a placement reads only its own Fabric's talosconfig, and the latest write of
// it when the Fabric was written twice.
func TestLatestHeldFor(t *testing.T) {
	held := []heldTalosconfig{
		{fabricJobID: "fab-a", talosconfig: "A1"},
		{fabricJobID: "fab-b", talosconfig: "B1"},
		{fabricJobID: "fab-a", talosconfig: "A2"},
	}
	if got, ok := latestHeldFor(held, map[string]bool{"fab-a": true}); !ok || got != "A2" {
		t.Errorf("fab-a = (%q, %v), want the later write A2", got, ok)
	}
	if got, ok := latestHeldFor(held, map[string]bool{"fab-b": true}); !ok || got != "B1" {
		t.Errorf("fab-b = (%q, %v), want B1", got, ok)
	}
	if got, ok := latestHeldFor(held, map[string]bool{"fab-c": true}); ok {
		t.Errorf("a Fabric that wrote nothing must read as absent, got %q", got)
	}
	if _, ok := latestHeldFor(nil, map[string]bool{"fab-a": true}); ok {
		t.Error("nothing held must read as absent")
	}
}

// fakeTalosStore answers talosStore from memory.
type fakeTalosStore struct {
	token    string                  // the one runner's valid token hash
	jobs     map[string]*talosJobRow // job id → row
	clusters map[string]string       // job id → reported execution_metadata.cluster_name
	err      error                   // returned by every read when set
}

// runnerAuthenticated reports whether the hash is the fake runner's.
func (f *fakeTalosStore) runnerAuthenticated(_ context.Context, runnerID, tokenHash string) (bool, error) {
	return runnerID == "r-1" && tokenHash == f.token, f.err
}

// job returns the seeded row, or nil.
func (f *fakeTalosStore) job(_ context.Context, jobID string) (*talosJobRow, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.jobs[jobID], nil
}

// jobsReportingCluster filters jobIDs by their seeded cluster name.
func (f *fakeTalosStore) jobsReportingCluster(_ context.Context, jobIDs []string, cluster string) (map[string]bool, error) {
	out := map[string]bool{}
	for _, id := range jobIDs {
		if f.clusters[id] == cluster {
			out[id] = true
		}
	}
	return out, f.err
}

// TestControlPlane_TalosconfigRoundTrip drives both handlers through the mux: the dedicated deploy
// writes, a placement on the same Fabric reads it back, a placement on another Fabric reads null, and
// every refusal comes back without the credential in it.
func TestControlPlane_TalosconfigRoundTrip(t *testing.T) {
	const talos = "context: fabric-a\ncontexts: {}\n"
	store := &fakeTalosStore{
		token: sha256Hex("tok"),
		jobs: map[string]*talosJobRow{
			"base": {runnerID: "r-1", jobType: "DEPLOY", status: "PROCESSING", snapshot: []byte(`{"provider":"hetzner"}`)},
			"dev": {runnerID: "r-1", jobType: "DEPLOY", status: "PROCESSING",
				snapshot: []byte(`{"provider":"hetzner","placement_mode":"namespace","cluster":{"cluster_name":"fab-a"}}`)},
			"other": {runnerID: "r-1", jobType: "DEPLOY", status: "PROCESSING",
				snapshot: []byte(`{"provider":"hetzner","placement_mode":"vcluster","cluster":{"cluster_name":"fab-b"}}`)},
		},
		clusters: map[string]string{"base": "fab-a"},
	}
	cp := &ControlPlane{talosStore: store}
	h := cp.mux()
	do := func(method, job, token, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, "/api/jobs/"+job+"/talosconfig", strings.NewReader(body))
		req.Header.Set("X-Runner-ID", "r-1")
		req.Header.Set("X-Runner-Token", token)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK && strings.Contains(rec.Body.String(), "fabric-a") {
			t.Fatalf("%s %s refused with the talosconfig in the body: %q", method, job, rec.Body.String())
		}
		return rec
	}
	putBody, _ := json.Marshal(map[string]string{"talosconfig": talos})

	// Refusals first, so nothing is held yet.
	if rec := do(http.MethodPut, "base", "wrong", string(putBody)); rec.Code != http.StatusUnauthorized {
		t.Errorf("wrong token PUT = %d, want 401", rec.Code)
	}
	if rec := do(http.MethodPut, "dev", "tok", string(putBody)); rec.Code != http.StatusForbidden {
		t.Errorf("placement PUT = %d, want 403 (only the dedicated deploy may write)", rec.Code)
	}
	if rec := do(http.MethodPut, "missing", "tok", string(putBody)); rec.Code != http.StatusNotFound {
		t.Errorf("unknown job PUT = %d, want 404", rec.Code)
	}
	if rec := do(http.MethodPut, "base", "tok", `{"talosconfig":"  "}`); rec.Code != http.StatusBadRequest {
		t.Errorf("empty talosconfig PUT = %d, want 400", rec.Code)
	}
	huge, _ := json.Marshal(map[string]string{"talosconfig": strings.Repeat("x", maxHarnessTalosconfigBytes+1)})
	if rec := do(http.MethodPut, "base", "tok", string(huge)); rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized PUT = %d, want 413", rec.Code)
	}
	hugeEnvelope := strings.Repeat("x", maxHarnessTalosconfigBytes+2048)
	if rec := do(http.MethodPut, "base", "tok", hugeEnvelope); rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized body PUT = %d, want 413", rec.Code)
	}
	if rec := do(http.MethodGet, "dev", "tok", ""); rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"talosconfig":null}` {
		t.Errorf("GET before any write = %d %q, want 200 {talosconfig:null}", rec.Code, rec.Body.String())
	}

	// The write-back, then the placement's read.
	if rec := do(http.MethodPut, "base", "tok", string(putBody)); rec.Code != http.StatusOK {
		t.Fatalf("dedicated PUT = %d %q, want 200", rec.Code, rec.Body.String())
	}
	rec := do(http.MethodGet, "dev", "tok", "")
	var got struct {
		Talosconfig *string `json:"talosconfig"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || rec.Code != http.StatusOK || got.Talosconfig == nil || *got.Talosconfig != talos {
		t.Fatalf("placement GET = %d %q, want the written talosconfig", rec.Code, rec.Body.String())
	}
	if rec := do(http.MethodGet, "other", "tok", ""); strings.TrimSpace(rec.Body.String()) != `{"talosconfig":null}` {
		t.Errorf("a placement on another Fabric read %q, want null", rec.Body.String())
	}

	// A failing store is a 500, never a served credential.
	store.err = errors.New("db down")
	if rec := do(http.MethodGet, "dev", "tok", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("GET with an unreadable runner table = %d, want 401", rec.Code)
	}
	store.err = nil
	store.jobs["dev"] = nil
	if rec := do(http.MethodGet, "dev", "tok", ""); rec.Code != http.StatusNotFound {
		t.Errorf("GET for a vanished job = %d, want 404", rec.Code)
	}
}

// TestControlPlane_TalosconfigStoreErrors covers the 500 arms: an unreadable job and an unresolvable
// Fabric.
func TestControlPlane_TalosconfigStoreErrors(t *testing.T) {
	store := &erroringTalosStore{fakeTalosStore: fakeTalosStore{
		token: sha256Hex("tok"),
		jobs: map[string]*talosJobRow{"dev": {runnerID: "r-1", jobType: "DEPLOY", status: "PROCESSING",
			snapshot: []byte(`{"provider":"hetzner","placement_mode":"namespace","cluster":{"cluster_name":"fab-a"}}`)}},
	}}
	cp := &ControlPlane{talosStore: store, talosHeld: []heldTalosconfig{{fabricJobID: "base", talosconfig: "secret-a"}}}
	h := cp.mux()
	for _, tc := range []struct {
		name    string
		failJob bool
	}{{"job read fails", true}, {"fabric resolution fails", false}} {
		t.Run(tc.name, func(t *testing.T) {
			store.failJob, store.failResolve = tc.failJob, !tc.failJob
			req := httptest.NewRequest(http.MethodGet, "/api/jobs/dev/talosconfig", nil)
			req.Header.Set("X-Runner-ID", "r-1")
			req.Header.Set("X-Runner-Token", "tok")
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "secret-a") {
				t.Errorf("= %d %q, want a 500 without the credential", rec.Code, rec.Body.String())
			}
		})
	}
}

// erroringTalosStore fails the job read or the Fabric resolution on demand.
type erroringTalosStore struct {
	fakeTalosStore
	failJob, failResolve bool
}

// job fails when failJob is set.
func (e *erroringTalosStore) job(ctx context.Context, jobID string) (*talosJobRow, error) {
	if e.failJob {
		return nil, errors.New("job read failed")
	}
	return e.fakeTalosStore.job(ctx, jobID)
}

// jobsReportingCluster fails when failResolve is set.
func (e *erroringTalosStore) jobsReportingCluster(ctx context.Context, ids []string, cluster string) (map[string]bool, error) {
	if e.failResolve {
		return nil, errors.New("resolve failed")
	}
	return e.fakeTalosStore.jobsReportingCluster(ctx, ids, cluster)
}
