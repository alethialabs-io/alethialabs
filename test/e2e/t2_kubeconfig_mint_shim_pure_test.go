// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FREE, every-PR proof that the kubeconfig-mint shim answers the console route's status code in every
// case (#5959) — no build tag, no Postgres. The route is apps/console/app/api/jobs/[id]/kubeconfig-mint
// (lib/kubeconfig-mint/runner.ts) as #5945 left it; the runner's mintStatusError reads each code as a
// different ending, so a shim that answers the old contract tells a T2 runner the wrong thing.
package e2e

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// TestMintShim_StatusPerCase pins one case per status the route answers, through the shim's pure
// decision for that case.
func TestMintShim_StatusPerCase(t *testing.T) {
	const runner = "r-1"
	executing := &mintJobGate{runnerID: runner, jobType: "MINT_KUBECONFIG", status: "PROCESSING"}
	pending := &mintRequestRow{ID: "m-1", Status: "pending"}
	for _, tc := range []struct {
		name string
		got  func() int
		want int
	}{
		// 404 — the job, or the mint row it serves, does not exist.
		{"job missing", func() int { c, _ := mintGateRefusal(nil, runner); return c }, http.StatusNotFound},
		{"row missing at the result post", func() int { c, _ := mintResultRowRefusal(nil, "m-1"); return c }, http.StatusNotFound},
		// 403 — the job is not this runner's to use, or the post names another mint.
		{"another runner's job", func() int {
			c, _ := mintGateRefusal(&mintJobGate{runnerID: "r-2", jobType: "MINT_KUBECONFIG", status: "PROCESSING"}, runner)
			return c
		}, http.StatusForbidden},
		{"mint_id mismatch", func() int { c, _ := mintResultRowRefusal(pending, "m-other"); return c }, http.StatusForbidden},
		{"mint_id mismatch beats an expired row", func() int {
			c, _ := mintResultRowRefusal(&mintRequestRow{ID: "m-1", Status: "expired"}, "m-other")
			return c
		}, http.StatusForbidden},
		{"mint_id mismatch beats a settled row", func() int {
			c, _ := mintResultRowRefusal(&mintRequestRow{ID: "m-1", Status: "ready"}, "m-other")
			return c
		}, http.StatusForbidden},
		{"completion refused AL409 (ownership lost at the write)", func() int {
			c, _ := mintCompletionRefusal(fmt.Errorf("exec: %w", &pgconn.PgError{Code: "AL409"}))
			return c
		}, http.StatusForbidden},
		// 410 — the window closed.
		{"past expires_at at the head read", func() int {
			c, _ := mintResultRowRefusal(&mintRequestRow{ID: "m-1", Status: "pending", ExpiredNow: true}, "m-1")
			return c
		}, http.StatusGone},
		{"swept at the head read", func() int {
			c, _ := mintResultRowRefusal(&mintRequestRow{ID: "m-1", Status: "expired"}, "m-1")
			return c
		}, http.StatusGone},
		{"lost the write to the window (row still pending)", func() int {
			c, _ := mintLostRaceRefusal(&mintRequestRow{Status: "pending"})
			return c
		}, http.StatusGone},
		{"lost the write to the sweep (row expired)", func() int {
			c, _ := mintLostRaceRefusal(&mintRequestRow{Status: "expired"})
			return c
		}, http.StatusGone},
		// 409 — the mint already has a result. Nothing else.
		{"settled at the head read", func() int {
			c, _ := mintResultRowRefusal(&mintRequestRow{ID: "m-1", Status: "failed"}, "m-1")
			return c
		}, http.StatusConflict},
		{"lost the write to a second post (row ready)", func() int {
			c, _ := mintLostRaceRefusal(&mintRequestRow{Status: "ready"})
			return c
		}, http.StatusConflict},
		{"lost the write to a second post (row failed)", func() int {
			c, _ := mintLostRaceRefusal(&mintRequestRow{Status: "failed"})
			return c
		}, http.StatusConflict},
		{"lost the write to a second post (row already read and deleted)", func() int {
			c, _ := mintLostRaceRefusal(nil)
			return c
		}, http.StatusConflict},
		// 500 — a completion error that is not AL409.
		{"completion failed otherwise", func() int {
			c, _ := mintCompletionRefusal(&pgconn.PgError{Code: "23505"})
			return c
		}, http.StatusInternalServerError},
		{"completion failed with no Postgres code", func() int {
			c, _ := mintCompletionRefusal(errors.New("conn reset"))
			return c
		}, http.StatusInternalServerError},
		// 0 — admitted.
		{"executing job, pending row, its own mint_id", func() int {
			if c, _ := mintGateRefusal(executing, runner); c != 0 {
				return c
			}
			c, _ := mintResultRowRefusal(pending, "m-1")
			return c
		}, 0},
	} {
		if got := tc.got(); got != tc.want {
			t.Errorf("%s = %d, want %d", tc.name, got, tc.want)
		}
	}
}

// TestMintShim_CompletionNeverAnswers409 pins #5945 itself: no failure of update_job_status answers
// 409, which the runner would read as a settled mint and follow with a SUCCESS post.
func TestMintShim_CompletionNeverAnswers409(t *testing.T) {
	for _, err := range []error{&pgconn.PgError{Code: "AL409"}, &pgconn.PgError{Code: "40001"}, errors.New("x")} {
		if c, _ := mintCompletionRefusal(err); c == http.StatusConflict {
			t.Errorf("completion error %v answered 409", err)
		}
	}
}

// TestMintShim_ResultPostOrder drives the result post through the mux: a mint_id naming another mint
// is a 403 even when this job's own mint has expired or settled, as recordMintResult checks it first;
// and the store's landing code (lost race, refused completion) reaches the runner unchanged.
func TestMintShim_ResultPostOrder(t *testing.T) {
	exec := &mintJobGate{runnerID: "r-1", jobType: "MINT_KUBECONFIG", status: "PROCESSING"}
	ms := &fakeMintStore{
		jobs: map[string]*mintJobGate{"expired": exec, "settled": exec, "ok": exec},
		rows: map[string]*mintRequestRow{
			"expired": {ID: "m-exp", Status: "expired"},
			"settled": {ID: "m-set", Status: "ready"},
			"ok":      {ID: "m-ok", Status: "pending"},
		},
	}
	cp := &ControlPlane{talosStore: &fakeTalosStore{token: sha256Hex("tok")}, mintStore: ms, stateAlias: map[string]string{}}
	h := cp.mux()
	post := func(job, mintID string) int {
		body := `{"status":"ready","mint_id":"` + mintID + `","sealed":"c2VhbGVk","private_endpoint":false}`
		req := httptest.NewRequest(http.MethodPost, "/api/jobs/"+job+"/kubeconfig-mint", strings.NewReader(body))
		req.Header.Set("X-Runner-ID", "r-1")
		req.Header.Set("X-Runner-Token", "tok")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	for _, tc := range []struct {
		job, mintID string
		want        int
	}{
		{"expired", "m-other", http.StatusForbidden},
		{"settled", "m-other", http.StatusForbidden},
		{"expired", "m-exp", http.StatusGone},
		{"settled", "m-set", http.StatusConflict},
	} {
		if got := post(tc.job, tc.mintID); got != tc.want {
			t.Errorf("POST %s naming %s = %d, want %d", tc.job, tc.mintID, got, tc.want)
		}
	}
	if len(ms.landed) != 0 {
		t.Fatalf("a refused post landed %d result(s)", len(ms.landed))
	}
	for _, code := range []int{http.StatusGone, http.StatusConflict, http.StatusForbidden, http.StatusInternalServerError} {
		ms.landCode = code
		if got := post("ok", "m-ok"); got != code {
			t.Errorf("a landing answering %d reached the runner as %d", code, got)
		}
	}
}
