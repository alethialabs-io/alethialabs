// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestFetchManifest covers the operator rail's download: a served body is returned verbatim, and
// every unusable answer (non-200, empty body, unparseable URL) becomes an error naming the URL.
func TestFetchManifest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok.yaml":
			_, _ = w.Write([]byte("kind: CustomResourceDefinition\n"))
		case "/blank.yaml":
			_, _ = w.Write([]byte("   \n"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	tests := []struct {
		name    string
		url     string
		want    string
		wantErr string
	}{
		{name: "a served manifest is returned verbatim", url: srv.URL + "/ok.yaml", want: "kind: CustomResourceDefinition\n"},
		{name: "a 404 is an error", url: srv.URL + "/missing.yaml", wantErr: "HTTP 404"},
		{name: "a whitespace-only body is an error", url: srv.URL + "/blank.yaml", wantErr: "is empty"},
		{name: "an unparseable URL is an error", url: "://nope", wantErr: "bad manifest url"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := fetchManifest(context.Background(), tc.url)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("fetchManifest() error = %v, want it to contain %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("fetchManifest() error = %v, want nil", err)
			}
			if got != tc.want {
				t.Errorf("fetchManifest() = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestFetchManifestHonoursCancellation locks that the download is cancellable — the runner's deploy
// context must be able to abort a stalled operator fetch.
func TestFetchManifestHonoursCancellation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := fetchManifest(ctx, srv.URL+"/slow.yaml"); err == nil {
		t.Fatal("fetchManifest() returned nil error for a cancelled context")
	}
}

// TestApplyManifestAddOns covers the fail-soft aggregate contract: nothing to do is nil, a partial
// failure is nil (the healthy operators still installed), and an all-failed rail is an error.
func TestApplyManifestAddOns(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/good.yaml" {
			_, _ = w.Write([]byte("kind: CustomResourceDefinition\n"))
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	manifestAddOn := func(id, path string, crds ...string) types.AddOnInstall {
		return types.AddOnInstall{ID: id, Mode: "managed", Source: "manifest", ChartRepo: srv.URL + path, Version: "v1.0.0", CRDs: crds}
	}

	tests := []struct {
		name     string
		addons   []types.AddOnInstall
		exitCode int
		wantErr  string
		wantWait bool
	}{
		{
			name:   "no manifest add-ons is a no-op",
			addons: []types.AddOnInstall{{ID: "grafana", Mode: "managed"}},
		},
		{
			name:     "a good manifest is applied and its CRDs are waited for",
			addons:   []types.AddOnInstall{manifestAddOn("rabbitmq-operator", "/good.yaml", "rabbitmqclusters.rabbitmq.com")},
			wantWait: true,
		},
		{
			name: "one bad fetch among several is survivable",
			addons: []types.AddOnInstall{
				manifestAddOn("rabbitmq-operator", "/good.yaml"),
				manifestAddOn("broken-operator", "/bad.yaml"),
			},
		},
		{
			name:    "every manifest failing is a hard error",
			addons:  []types.AddOnInstall{manifestAddOn("broken-operator", "/bad.yaml")},
			wantErr: "all 1 operator manifest add-on(s) failed to install",
		},
		{
			name:     "a CRD that never establishes fails that add-on",
			addons:   []types.AddOnInstall{manifestAddOn("rabbitmq-operator", "/good.yaml", "rabbitmqclusters.rabbitmq.com")},
			exitCode: 1,
			wantErr:  "all 1 operator manifest add-on(s) failed to install",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			stub := newKubectlStub(t, tc.exitCode)
			var stdout, stderr bytes.Buffer
			err := ApplyManifestAddOns(context.Background(), tc.addons, &stdout, &stderr)

			if tc.wantErr == "" && err != nil {
				t.Fatalf("ApplyManifestAddOns() error = %v, want nil", err)
			}
			if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("ApplyManifestAddOns() error = %v, want it to contain %q", err, tc.wantErr)
			}
			if tc.wantWait && !stub.calledWith("wait --for=condition=established") {
				t.Errorf("the CRD wait never ran; calls: %v", stub.calls())
			}
		})
	}
}

// TestApplyManifestServerSideUsesForceConflicts locks that the operator rail applies server-side
// with --force-conflicts, which is what makes a re-deploy idempotent over a previous apply's fields.
func TestApplyManifestServerSideUsesForceConflicts(t *testing.T) {
	stub := newKubectlStub(t, 0)
	var stdout, stderr bytes.Buffer
	if err := applyManifestServerSide("kind: ConfigMap\n", &stdout, &stderr); err != nil {
		t.Fatalf("applyManifestServerSide() error = %v", err)
	}
	if !stub.calledWith("apply --server-side --force-conflicts -f") {
		t.Errorf("server-side apply flags missing; calls: %v", stub.calls())
	}
}

// TestApplyManifestServerSideSurfacesFailure locks that a non-zero kubectl is reported, not swallowed.
func TestApplyManifestServerSideSurfacesFailure(t *testing.T) {
	newKubectlStub(t, 1)
	var stdout, stderr bytes.Buffer
	err := applyManifestServerSide("kind: ConfigMap\n", &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "kubectl apply failed") {
		t.Fatalf("applyManifestServerSide() error = %v, want a kubectl apply failure", err)
	}
}
