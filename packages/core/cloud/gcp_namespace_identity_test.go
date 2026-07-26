// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNamespaceGSAAccountID(t *testing.T) {
	a := namespaceGSAAccountID("cluster-1", "team-web")
	b := namespaceGSAAccountID("cluster-1", "team-web")
	c := namespaceGSAAccountID("cluster-2", "team-web")
	if a != b {
		t.Errorf("not deterministic: %q vs %q", a, b)
	}
	if a == c {
		t.Error("different clusters must yield different account ids")
	}
	if len(a) < 6 || len(a) > 30 || !strings.HasPrefix(a, "nsid-") {
		t.Errorf("account id %q is not a valid 6–30 char GCP SA id", a)
	}
}

func TestGKEWorkloadIdentityMember(t *testing.T) {
	got := gkeWorkloadIdentityMember("proj-1", "team-web")
	if want := "serviceAccount:proj-1.svc.id.goog[team-web/default]"; got != want {
		t.Fatalf("member = %q, want %q", got, want)
	}
}

func TestIsValidGSAEmail(t *testing.T) {
	if !IsValidGSAEmail("nsid-abcdef0123456789@proj-1.iam.gserviceaccount.com") {
		t.Error("valid GSA email rejected")
	}
	for _, bad := range []string{"", "not-an-email", "x@evil.com", "a b@proj.iam.gserviceaccount.com", "nsid-x@proj.iam.gserviceaccount.com; rm -rf /"} {
		if IsValidGSAEmail(bad) {
			t.Errorf("malformed/hostile GSA email %q accepted", bad)
		}
	}
}

func TestIAMMemberHelpers(t *testing.T) {
	pol := iamPolicy{Bindings: []iamBinding{{Role: "roles/other", Members: []string{"user:x"}}}}
	if iamPolicyHasMember(pol, gkeWorkloadIdentityUserRole, "m") {
		t.Error("false positive on absent binding")
	}
	pol.Bindings = addIAMMember(pol.Bindings, gkeWorkloadIdentityUserRole, "m")
	if !iamPolicyHasMember(pol, gkeWorkloadIdentityUserRole, "m") {
		t.Error("member not added")
	}
	// Preserves the pre-existing unrelated binding.
	if len(pol.Bindings) != 2 {
		t.Errorf("expected 2 bindings, got %d", len(pol.Bindings))
	}
}

// gkeIAMStub routes the three IAM calls and records whether setIamPolicy was called + its body.
type gkeIAMStub struct {
	createStatus int
	getPolicy    string
	setCalled    bool
	setBody      string
}

func (s *gkeIAMStub) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer wif-token" {
			t.Errorf("missing/wrong bearer: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, ":getIamPolicy"):
			_, _ = w.Write([]byte(s.getPolicy))
		case strings.HasSuffix(r.URL.Path, ":setIamPolicy"):
			s.setCalled = true
			b, _ := io.ReadAll(r.Body)
			s.setBody = string(b)
			_, _ = w.Write([]byte(`{}`))
		case strings.HasSuffix(r.URL.Path, "/serviceAccounts"):
			w.WriteHeader(s.createStatus)
			_, _ = w.Write([]byte(`{}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}
}

func TestProvisionGKENamespaceIdentity(t *testing.T) {
	const wantEmail = "nsid-" // prefix; full email asserted below
	member := gkeWorkloadIdentityMember("proj-1", "team-web")

	t.Run("create + bind", func(t *testing.T) {
		stub := &gkeIAMStub{createStatus: http.StatusOK, getPolicy: `{"bindings":[]}`}
		srv := httptest.NewServer(stub.handler(t))
		defer srv.Close()
		client, _ := clientTo(srv)
		email, err := ProvisionGKENamespaceIdentity(context.Background(), client, "wif-token", "proj-1", "cluster-1", "team-web")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !strings.HasPrefix(email, wantEmail) || !strings.HasSuffix(email, "@proj-1.iam.gserviceaccount.com") {
			t.Errorf("email = %q, want nsid-…@proj-1.iam.gserviceaccount.com", email)
		}
		if !IsValidGSAEmail(email) {
			t.Errorf("returned email %q is not shell-safe", email)
		}
		if !stub.setCalled {
			t.Fatal("setIamPolicy was not called — binding not persisted")
		}
		var sent map[string]any
		_ = json.Unmarshal([]byte(stub.setBody), &sent)
		if !strings.Contains(stub.setBody, gkeWorkloadIdentityUserRole) || !strings.Contains(stub.setBody, member) {
			t.Errorf("setIamPolicy body missing the workloadIdentityUser binding for %q: %s", member, stub.setBody)
		}
	})

	t.Run("idempotent — SA already exists (409)", func(t *testing.T) {
		stub := &gkeIAMStub{createStatus: http.StatusConflict, getPolicy: `{"bindings":[]}`}
		srv := httptest.NewServer(stub.handler(t))
		defer srv.Close()
		client, _ := clientTo(srv)
		if _, err := ProvisionGKENamespaceIdentity(context.Background(), client, "wif-token", "proj-1", "cluster-1", "team-web"); err != nil {
			t.Fatalf("409 on create must be tolerated (get-or-create), got: %v", err)
		}
	})

	t.Run("idempotent — binding already present skips setIamPolicy", func(t *testing.T) {
		existing := `{"bindings":[{"role":"` + gkeWorkloadIdentityUserRole + `","members":["` + member + `"]}]}`
		stub := &gkeIAMStub{createStatus: http.StatusOK, getPolicy: existing}
		srv := httptest.NewServer(stub.handler(t))
		defer srv.Close()
		client, _ := clientTo(srv)
		if _, err := ProvisionGKENamespaceIdentity(context.Background(), client, "wif-token", "proj-1", "cluster-1", "team-web"); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if stub.setCalled {
			t.Error("setIamPolicy called even though the binding already existed (not idempotent)")
		}
	})

	t.Run("empty token fails closed", func(t *testing.T) {
		if _, err := ProvisionGKENamespaceIdentity(context.Background(), nil, "", "proj-1", "cluster-1", "team-web"); err == nil {
			t.Error("empty token = nil error, want a fail-closed error")
		}
	})
}
