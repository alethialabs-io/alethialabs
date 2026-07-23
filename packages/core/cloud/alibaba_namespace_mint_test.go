// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// ackRewriteTransport redirects every request to base (a test server), preserving the path — so the
// resolver's real https://cs.<region>.aliyuncs.com/... URL lands on the stub and the path is asserted.
type ackRewriteTransport struct{ base *url.URL }

func (t ackRewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = t.base.Scheme
	req.URL.Host = t.base.Host
	return http.DefaultTransport.RoundTrip(req)
}

func ackClientTo(srv *httptest.Server) *http.Client {
	base, _ := url.Parse(srv.URL)
	return &http.Client{Transport: ackRewriteTransport{base: base}}
}

func ackKubeconfig(server, ca string) string {
	return "apiVersion: v1\nkind: Config\nclusters:\n- name: ack-1\n  cluster:\n    server: " + server +
		"\n    certificate-authority-data: " + ca + "\n"
}

const ackUserConfigPath = "/k8s/ack-1/user_config"

func ackHandler(t *testing.T, configField string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != ackUserConfigPath {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		if r.URL.Query().Get("PrivateIpAddress") != "false" {
			t.Errorf("expected the PUBLIC endpoint (PrivateIpAddress=false), got %q", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		body, _ := json.Marshal(map[string]string{"config": configField})
		_, _ = w.Write(body)
	}
}

func TestResolveACKClusterConn_Success_RawYAML(t *testing.T) {
	srv := httptest.NewServer(ackHandler(t, ackKubeconfig("https://1.2.3.4:6443", "BASE64CA==")))
	defer srv.Close()
	conn, err := ResolveACKClusterConn(context.Background(), ackClientTo(srv), "eu-central-1", "ack-1")
	if err != nil {
		t.Fatalf("ResolveACKClusterConn: %v", err)
	}
	if conn.Endpoint != "https://1.2.3.4:6443" {
		t.Errorf("Endpoint = %q", conn.Endpoint)
	}
	if conn.CAData != "BASE64CA==" {
		t.Errorf("CAData = %q, want BASE64CA==", conn.CAData)
	}
}

func TestResolveACKClusterConn_Success_Base64Wrapped(t *testing.T) {
	wrapped := base64.StdEncoding.EncodeToString([]byte(ackKubeconfig("https://5.6.7.8:6443", "CA2==")))
	srv := httptest.NewServer(ackHandler(t, wrapped))
	defer srv.Close()
	conn, err := ResolveACKClusterConn(context.Background(), ackClientTo(srv), "eu-central-1", "ack-1")
	if err != nil {
		t.Fatalf("ResolveACKClusterConn (base64-wrapped): %v", err)
	}
	if conn.Endpoint != "https://5.6.7.8:6443" || conn.CAData != "CA2==" {
		t.Errorf("conn = %+v", conn)
	}
}

func TestResolveACKClusterConn_NoConfig(t *testing.T) {
	srv := httptest.NewServer(ackHandler(t, ""))
	defer srv.Close()
	_, err := ResolveACKClusterConn(context.Background(), ackClientTo(srv), "eu-central-1", "ack-1")
	if !errors.Is(err, ErrACKClusterNotReady) {
		t.Fatalf("want ErrACKClusterNotReady for an empty config, got %v", err)
	}
}

func TestResolveACKClusterConn_MissingServerOrCA(t *testing.T) {
	srv := httptest.NewServer(ackHandler(t, ackKubeconfig("", "")))
	defer srv.Close()
	_, err := ResolveACKClusterConn(context.Background(), ackClientTo(srv), "eu-central-1", "ack-1")
	if !errors.Is(err, ErrACKClusterNotReady) {
		t.Fatalf("want ErrACKClusterNotReady for a kubeconfig missing server/CA, got %v", err)
	}
}

func TestResolveACKClusterConn_Non200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"Code":"Forbidden.RAM"}`))
	}))
	defer srv.Close()
	_, err := ResolveACKClusterConn(context.Background(), ackClientTo(srv), "eu-central-1", "ack-1")
	if err == nil {
		t.Fatal("expected an error on 403")
	}
	if errors.Is(err, ErrACKClusterNotReady) {
		t.Fatal("a 403 must not be reported as not-ready")
	}
}

func TestResolveACKClusterConn_InputValidation(t *testing.T) {
	ctx := context.Background()
	if _, err := ResolveACKClusterConn(ctx, nil, "", "c"); err == nil {
		t.Error("expected an error for an empty region")
	}
	if _, err := ResolveACKClusterConn(ctx, nil, "r", ""); err == nil {
		t.Error("expected an error for an empty cluster id")
	}
}
