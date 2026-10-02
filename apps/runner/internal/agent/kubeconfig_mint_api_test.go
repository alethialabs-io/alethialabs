// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/kubeaccess"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// mintRouteServer stands in for apps/console/app/api/jobs/[id]/kubeconfig-mint/route.ts: GET answers
// getStatus (and the spec on 200), POST answers postStatus and records the body.
func mintRouteServer(t *testing.T, getStatus, postStatus int, spec any) (*httptest.Server, *[]byte) {
	t.Helper()
	var posted []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/jobs/job-1/kubeconfig-mint" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		if r.Header.Get("X-Runner-ID") != "runner-1" || r.Header.Get("X-Runner-Token") != "rt" {
			t.Errorf("the runner credentials were not sent")
		}
		switch r.Method {
		case http.MethodGet:
			w.WriteHeader(getStatus)
			if getStatus == http.StatusOK {
				_ = json.NewEncoder(w).Encode(spec)
			} else {
				_, _ = io.WriteString(w, `{"error":"refused"}`)
			}
		case http.MethodPost:
			posted, _ = io.ReadAll(r.Body)
			w.WriteHeader(postStatus)
			_, _ = io.WriteString(w, `{"ok":true}`)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &posted
}

// validSpec is a spec that passes Validate.
func validSpec(t *testing.T) types.RunnerKubeconfigMintSpec {
	t.Helper()
	key, err := kubeaccess.GenerateClientKey()
	if err != nil {
		t.Fatal(err)
	}
	return types.RunnerKubeconfigMintSpec{
		MintID: testMintID, ClusterID: testClusterID, Tier: types.KubeconfigMintTierReadonly,
		Shape: types.KubeconfigMintShapeExec, TTLSeconds: 3600, ClientPublicKey: key.PublicKey(),
	}
}

// TestFetchKubeconfigMintSpec reads a valid spec and maps every refusal code.
func TestFetchKubeconfigMintSpec(t *testing.T) {
	spec := validSpec(t)
	srv, _ := mintRouteServer(t, http.StatusOK, http.StatusOK, spec)
	got, err := NewRunnerAPIClient(srv.URL, "runner-1", "rt").FetchKubeconfigMintSpec("job-1")
	if err != nil || got != spec {
		t.Fatalf("got %+v, %v", got, err)
	}

	for code, want := range map[int]error{
		http.StatusGone:      errMintWindowClosed,
		http.StatusConflict:  errMintSettled,
		http.StatusNotFound:  errMintNotFound,
		http.StatusForbidden: ErrJobNotOwned,
	} {
		srv, _ := mintRouteServer(t, code, http.StatusOK, nil)
		if _, err := NewRunnerAPIClient(srv.URL, "runner-1", "rt").FetchKubeconfigMintSpec("job-1"); !errors.Is(err, want) {
			t.Fatalf("status %d: got %v, want %v", code, err, want)
		}
	}
	srv, _ = mintRouteServer(t, http.StatusInternalServerError, http.StatusOK, nil)
	if _, err := NewRunnerAPIClient(srv.URL, "runner-1", "rt").FetchKubeconfigMintSpec("job-1"); err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("a 500 must be an error naming the code, got %v", err)
	}

	// An answer that is not a valid spec is refused before any mint work.
	bad := spec
	bad.TTLSeconds = 60
	srv, _ = mintRouteServer(t, http.StatusOK, http.StatusOK, bad)
	if _, err := NewRunnerAPIClient(srv.URL, "runner-1", "rt").FetchKubeconfigMintSpec("job-1"); !errors.Is(err, types.ErrKubeconfigMintInvalid) {
		t.Fatalf("an invalid spec must be refused, got %v", err)
	}
	srv, _ = mintRouteServer(t, http.StatusOK, http.StatusOK, "not an object")
	if _, err := NewRunnerAPIClient(srv.URL, "runner-1", "rt").FetchKubeconfigMintSpec("job-1"); err == nil {
		t.Fatal("a non-object answer must be refused")
	}
	if _, err := NewRunnerAPIClient("http://127.0.0.1:1", "runner-1", "rt").FetchKubeconfigMintSpec("job-1"); err == nil {
		t.Fatal("an unreachable console must be an error")
	}
}

// TestPostKubeconfigMintResult posts exactly the wire shape, refuses an invalid result before it
// leaves, and maps every refusal code.
func TestPostKubeconfigMintResult(t *testing.T) {
	f := false
	ready := types.RunnerKubeconfigMintResult{Status: types.KubeconfigMintStatusReady, MintID: testMintID, Sealed: "c2VhbGVk", PrivateEndpoint: &f}
	srv, posted := mintRouteServer(t, http.StatusOK, http.StatusOK, nil)
	if err := NewRunnerAPIClient(srv.URL, "runner-1", "rt").PostKubeconfigMintResult("job-1", ready); err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(*posted, &wire); err != nil {
		t.Fatal(err)
	}
	// The console's runnerKubeconfigMintResult is .strict(): exactly these keys, nothing riding along.
	if len(wire) != 4 || wire["status"] != "ready" || wire["mint_id"] != testMintID || wire["sealed"] != "c2VhbGVk" || wire["private_endpoint"] != false {
		t.Fatalf("posted %s", *posted)
	}

	failed := types.RunnerKubeconfigMintResult{Status: types.KubeconfigMintStatusFailed, MintID: testMintID, Reason: mintReasonNotFound}
	srv, posted = mintRouteServer(t, http.StatusOK, http.StatusOK, nil)
	if err := NewRunnerAPIClient(srv.URL, "runner-1", "rt").PostKubeconfigMintResult("job-1", failed); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(*posted), `"private_endpoint":null`) || strings.Contains(string(*posted), "sealed") {
		t.Fatalf("a failed result posts a reason, a null private_endpoint and no sealed: %s", *posted)
	}

	// Invalid results never leave the runner.
	srv, posted = mintRouteServer(t, http.StatusOK, http.StatusOK, nil)
	both := ready
	both.Reason = "x"
	if err := NewRunnerAPIClient(srv.URL, "runner-1", "rt").PostKubeconfigMintResult("job-1", both); !errors.Is(err, types.ErrKubeconfigMintInvalid) || *posted != nil {
		t.Fatalf("an invalid result must be refused before posting, got %v", err)
	}

	for code, want := range map[int]error{
		http.StatusGone:      errMintWindowClosed,
		http.StatusConflict:  errMintSettled,
		http.StatusForbidden: ErrJobNotOwned,
	} {
		srv, _ := mintRouteServer(t, http.StatusOK, code, nil)
		if err := NewRunnerAPIClient(srv.URL, "runner-1", "rt").PostKubeconfigMintResult("job-1", ready); !errors.Is(err, want) {
			t.Fatalf("status %d: got %v, want %v", code, err, want)
		}
	}
	if err := NewRunnerAPIClient("http://127.0.0.1:1", "runner-1", "rt").PostKubeconfigMintResult("job-1", ready); err == nil {
		t.Fatal("an unreachable console must be an error")
	}
}

// TestRunnerAPIClient_ImplementsTheMintChannel is the compile-time and runtime check the dispatcher's
// type assertion relies on: the production client HAS the channel, so production mints are not
// failed closed by accident.
func TestRunnerAPIClient_ImplementsTheMintChannel(t *testing.T) {
	var api JobAPI = NewRunnerAPIClient("http://x", "r", "t")
	if _, ok := api.(kubeconfigMintAPI); !ok {
		t.Fatal("RunnerAPIClient does not implement kubeconfigMintAPI")
	}
}
