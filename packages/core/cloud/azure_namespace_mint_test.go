// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// armRewriteTransport redirects every request to base (a test server), preserving the path + headers —
// so the resolver's real https://management.azure.com/... URLs land on the stub and the resource path +
// bearer header are still asserted.
type armRewriteTransport struct{ base *url.URL }

func (t armRewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = t.base.Scheme
	req.URL.Host = t.base.Host
	return http.DefaultTransport.RoundTrip(req)
}

func armClientTo(srv *httptest.Server) *http.Client {
	base, _ := url.Parse(srv.URL)
	return &http.Client{Transport: armRewriteTransport{base: base}}
}

// a minimal AKS user kubeconfig, base64'd as listClusterUserCredentials returns it.
func aksKubeconfigB64(ca string) string {
	kc := "apiVersion: v1\nkind: Config\nclusters:\n- name: aks-1\n  cluster:\n    server: https://aks-1.example\n    certificate-authority-data: " + ca + "\n"
	return base64.StdEncoding.EncodeToString([]byte(kc))
}

const aksResourcePath = "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.ContainerService/managedClusters/aks-1"

func TestAKSClusterResourceID(t *testing.T) {
	got := AKSClusterResourceID("sub-1", "rg-1", "aks-1")
	if got != aksResourcePath {
		t.Fatalf("AKSClusterResourceID = %q, want %q", got, aksResourcePath)
	}
}

// aksHandler routes the two ARM calls: GET the managed cluster, POST listClusterUserCredentials.
func aksHandler(t *testing.T, mcJSON, credJSON string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer arm-token" {
			t.Errorf("missing/wrong bearer: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == aksResourcePath:
			_, _ = w.Write([]byte(mcJSON))
		case r.Method == http.MethodPost && r.URL.Path == aksResourcePath+"/listClusterUserCredentials":
			_, _ = w.Write([]byte(credJSON))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}
}

func TestResolveAKSClusterConn_Success(t *testing.T) {
	mc := `{"properties":{"fqdn":"aks-1.hcp.eastus.azmk8s.io","provisioningState":"Succeeded","powerState":{"code":"Running"}}}`
	cred := `{"kubeconfigs":[{"name":"clusterUser","value":"` + aksKubeconfigB64("BASE64CA==") + `"}]}`
	srv := httptest.NewServer(aksHandler(t, mc, cred))
	defer srv.Close()

	conn, err := ResolveAKSClusterConn(
		context.Background(), armClientTo(srv), "arm-token", "sub-1", "rg-1", "aks-1",
	)
	if err != nil {
		t.Fatalf("ResolveAKSClusterConn: %v", err)
	}
	if conn.Endpoint != "https://aks-1.hcp.eastus.azmk8s.io" {
		t.Errorf("Endpoint = %q", conn.Endpoint)
	}
	if conn.CAData != "BASE64CA==" {
		t.Errorf("CAData = %q, want BASE64CA==", conn.CAData)
	}
}

func TestResolveAKSClusterConn_NotSucceeded(t *testing.T) {
	mc := `{"properties":{"fqdn":"aks-1.example","provisioningState":"Creating","powerState":{"code":"Running"}}}`
	srv := httptest.NewServer(aksHandler(t, mc, `{}`))
	defer srv.Close()
	_, err := ResolveAKSClusterConn(context.Background(), armClientTo(srv), "arm-token", "sub-1", "rg-1", "aks-1")
	if !errors.Is(err, ErrAKSClusterNotReady) {
		t.Fatalf("want ErrAKSClusterNotReady for a still-provisioning cluster, got %v", err)
	}
}

func TestResolveAKSClusterConn_Stopped(t *testing.T) {
	mc := `{"properties":{"fqdn":"aks-1.example","provisioningState":"Succeeded","powerState":{"code":"Stopped"}}}`
	srv := httptest.NewServer(aksHandler(t, mc, `{}`))
	defer srv.Close()
	_, err := ResolveAKSClusterConn(context.Background(), armClientTo(srv), "arm-token", "sub-1", "rg-1", "aks-1")
	if !errors.Is(err, ErrAKSClusterNotReady) {
		t.Fatalf("want ErrAKSClusterNotReady for a Stopped cluster, got %v", err)
	}
}

func TestResolveAKSClusterConn_EmptyCA(t *testing.T) {
	mc := `{"properties":{"fqdn":"aks-1.example","provisioningState":"Succeeded","powerState":{"code":"Running"}}}`
	cred := `{"kubeconfigs":[{"name":"clusterUser","value":"` + aksKubeconfigB64("") + `"}]}`
	srv := httptest.NewServer(aksHandler(t, mc, cred))
	defer srv.Close()
	_, err := ResolveAKSClusterConn(context.Background(), armClientTo(srv), "arm-token", "sub-1", "rg-1", "aks-1")
	if !errors.Is(err, ErrAKSClusterNotReady) {
		t.Fatalf("want ErrAKSClusterNotReady for an empty cluster CA, got %v", err)
	}
}

func TestResolveAKSClusterConn_Non200_DoesNotLeakToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"message":"AuthorizationFailed"}}`))
	}))
	defer srv.Close()
	_, err := ResolveAKSClusterConn(context.Background(), armClientTo(srv), "super-secret-token", "sub-1", "rg-1", "aks-1")
	if err == nil {
		t.Fatal("expected an error on 403")
	}
	if errors.Is(err, ErrAKSClusterNotReady) {
		t.Fatal("a 403 must not be reported as not-ready")
	}
	if strings.Contains(err.Error(), "super-secret-token") {
		t.Fatalf("the ARM token leaked into the error: %v", err)
	}
}

func TestResolveAKSClusterConn_InputValidation(t *testing.T) {
	ctx := context.Background()
	if _, err := ResolveAKSClusterConn(ctx, nil, "", "s", "r", "c"); err == nil {
		t.Error("expected an error for an empty ARM token")
	}
	if _, err := ResolveAKSClusterConn(ctx, nil, "t", "", "r", "c"); err == nil {
		t.Error("expected an error for an empty subscription")
	}
	if _, err := ResolveAKSClusterConn(ctx, nil, "t", "s", "", "c"); err == nil {
		t.Error("expected an error for an empty resource group")
	}
	if _, err := ResolveAKSClusterConn(ctx, nil, "t", "s", "r", ""); err == nil {
		t.Error("expected an error for an empty cluster name")
	}
}
