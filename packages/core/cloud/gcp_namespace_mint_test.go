// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// gkeRewriteTransport redirects every request to base (a test server), preserving the request path +
// headers — so the resolver's real https://container.googleapis.com/v1/... URL lands on the stub
// without real DNS, and the path (resource name) + Authorization header are still asserted.
type gkeRewriteTransport struct {
	base    *url.URL
	lastReq *http.Request
}

func (t *gkeRewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.lastReq = req.Clone(req.Context())
	req.URL.Scheme = t.base.Scheme
	req.URL.Host = t.base.Host
	return http.DefaultTransport.RoundTrip(req)
}

func TestGKEClusterResourceName(t *testing.T) {
	got := GKEClusterResourceName("proj-1", "europe-west3", "gke-abc")
	if want := "projects/proj-1/locations/europe-west3/clusters/gke-abc"; got != want {
		t.Fatalf("GKEClusterResourceName = %q, want %q", got, want)
	}
}

// clientTo builds an http.Client that redirects to srv and captures the outbound request.
func clientTo(srv *httptest.Server) (*http.Client, *gkeRewriteTransport) {
	base, _ := url.Parse(srv.URL)
	rt := &gkeRewriteTransport{base: base}
	return &http.Client{Transport: rt}, rt
}

func TestResolveGKEClusterConn_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/projects/proj-1/locations/europe-west3/clusters/gke-abc" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer wif-token" {
			t.Errorf("missing/wrong bearer: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"endpoint":"1.2.3.4","status":"RUNNING","masterAuth":{"clusterCaCertificate":"BASE64CA=="}}`))
	}))
	defer srv.Close()
	client, _ := clientTo(srv)

	conn, err := ResolveGKEClusterConn(
		context.Background(), client, "wif-token", "proj-1", "europe-west3", "gke-abc",
	)
	if err != nil {
		t.Fatalf("ResolveGKEClusterConn: %v", err)
	}
	if conn.Endpoint != "1.2.3.4" {
		t.Errorf("Endpoint = %q, want 1.2.3.4", conn.Endpoint)
	}
	if conn.CAData != "BASE64CA==" {
		t.Errorf("CAData = %q, want BASE64CA==", conn.CAData)
	}
}

func TestResolveGKEClusterConn_NotRunning(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"endpoint":"1.2.3.4","status":"PROVISIONING","masterAuth":{"clusterCaCertificate":"CA=="}}`))
	}))
	defer srv.Close()
	client, _ := clientTo(srv)
	_, err := ResolveGKEClusterConn(context.Background(), client, "t", "p", "l", "c")
	if !errors.Is(err, ErrGKEClusterNotReady) {
		t.Fatalf("want ErrGKEClusterNotReady for a non-RUNNING cluster, got %v", err)
	}
}

func TestResolveGKEClusterConn_MissingFields(t *testing.T) {
	// RUNNING but no endpoint/CA yet → not ready, never a partial conn.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"endpoint":"","status":"RUNNING","masterAuth":{"clusterCaCertificate":""}}`))
	}))
	defer srv.Close()
	client, _ := clientTo(srv)
	_, err := ResolveGKEClusterConn(context.Background(), client, "t", "p", "l", "c")
	if !errors.Is(err, ErrGKEClusterNotReady) {
		t.Fatalf("want ErrGKEClusterNotReady for empty endpoint/CA, got %v", err)
	}
}

func TestResolveGKEClusterConn_Non200_DoesNotLeakToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"message":"permission denied"}}`))
	}))
	defer srv.Close()
	client, _ := clientTo(srv)
	_, err := ResolveGKEClusterConn(context.Background(), client, "super-secret-token", "p", "l", "c")
	if err == nil {
		t.Fatal("expected an error on 403")
	}
	if errors.Is(err, ErrGKEClusterNotReady) {
		t.Fatal("a 403 must not be reported as not-ready")
	}
	if strings.Contains(err.Error(), "super-secret-token") {
		t.Fatalf("the access token leaked into the error: %v", err)
	}
}

func TestResolveGKEClusterConn_InputValidation(t *testing.T) {
	ctx := context.Background()
	if _, err := ResolveGKEClusterConn(ctx, nil, "", "p", "l", "c"); err == nil {
		t.Error("expected an error for an empty access token")
	}
	if _, err := ResolveGKEClusterConn(ctx, nil, "t", "", "l", "c"); err == nil {
		t.Error("expected an error for an empty project")
	}
	if _, err := ResolveGKEClusterConn(ctx, nil, "t", "p", "", "c"); err == nil {
		t.Error("expected an error for an empty location")
	}
	if _, err := ResolveGKEClusterConn(ctx, nil, "t", "p", "l", ""); err == nil {
		t.Error("expected an error for an empty cluster name")
	}
}
