// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package kubeaccess

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// testCAPEM is a fixed self-signed CA (ed25519, CN=kubernetes, valid 2026–2036). It is a public
// certificate with no key anywhere in the repository; it exists so golden kubeconfigs are stable.
const testCAPEM = `-----BEGIN CERTIFICATE-----
MIIBGjCBzaADAgECAgEBMAUGAytlcDAVMRMwEQYDVQQDEwprdWJlcm5ldGVzMB4X
DTI2MDEwMTAwMDAwMFoXDTM2MDEwMTAwMDAwMFowFTETMBEGA1UEAxMKa3ViZXJu
ZXRlczAqMAUGAytlcAMhADtqJ7zOtqQtYqOo0CpvDXNlMhV3HeJDpjrASKGLWdop
o0IwQDAOBgNVHQ8BAf8EBAMCAgQwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQU
E545QOZLVJFyIIjZoNdBYo/IJuAwBQYDK2VwA0EAacQ5d9pUr3w9jCCEKZStN4wt
AE5YxhzKYVZmevzl3joc6J8chtm5/jVukubmH1xfFl+vyqZC+b5MNbnhGlaEBA==
-----END CERTIFICATE-----
`

// testCAData is testCAPEM in the kubeconfig certificate-authority-data form.
var testCAData = base64.StdEncoding.EncodeToString([]byte(testCAPEM))

// genClientPair makes a throwaway client certificate and key, base64-encoded PEM, at test time (so
// no private key is ever committed).
func genClientPair(t *testing.T) (certB64, keyB64 string, cert *x509.Certificate) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(7), Subject: pkix.Name{CommonName: "alethia-test", Organization: []string{"alethia:view"}},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ = x509.ParseCertificate(der)
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return base64.StdEncoding.EncodeToString(certPEM), base64.StdEncoding.EncodeToString(keyPEM), cert
}

// serverCAData returns a TLS test server's certificate as certificate-authority-data.
func serverCAData(srv *httptest.Server) string {
	return base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))
}

// TestNewClient_Refuses every connection that is not pinned or not exactly one credential.
func TestNewClient_Refuses(t *testing.T) {
	certB64, keyB64, _ := genClientPair(t)
	otherCert, _, _ := genClientPair(t)
	cases := map[string]Conn{
		"http":                {Server: "http://api.example.com", CAData: testCAData, Token: "t"},
		"no host":             {Server: "https://", CAData: testCAData, Token: "t"},
		"userinfo":            {Server: "https://u:p@api.example.com", CAData: testCAData, Token: "t"},
		"query":               {Server: "https://api.example.com?x=1", CAData: testCAData, Token: "t"},
		"no CA":               {Server: "https://api.example.com", Token: "t"},
		"CA not base64":       {Server: "https://api.example.com", CAData: "%%%", Token: "t"},
		"CA not PEM":          {Server: "https://api.example.com", CAData: base64.StdEncoding.EncodeToString([]byte("nope")), Token: "t"},
		"no credential":       {Server: "https://api.example.com", CAData: testCAData},
		"two credentials":     {Server: "https://api.example.com", CAData: testCAData, Token: "t", ClientCertData: certB64, ClientKeyData: keyB64},
		"cert without key":    {Server: "https://api.example.com", CAData: testCAData, ClientCertData: certB64},
		"key without cert":    {Server: "https://api.example.com", CAData: testCAData, ClientKeyData: keyB64},
		"mismatched pair":     {Server: "https://api.example.com", CAData: testCAData, ClientCertData: otherCert, ClientKeyData: keyB64},
		"cert not base64 PEM": {Server: "https://api.example.com", CAData: testCAData, ClientCertData: "%%", ClientKeyData: keyB64},
	}
	for name, conn := range cases {
		if _, err := NewClient(conn); !errors.Is(err, ErrKubeAPI) {
			t.Errorf("%s: err = %v, want ErrKubeAPI", name, err)
		}
	}
	if _, err := NewClient(Conn{Server: "https://api.example.com/prefix", CAData: testCAData, ClientCertData: certB64, ClientKeyData: keyB64}); err != nil {
		t.Fatalf("a client-cert connection was refused: %v", err)
	}
}

// TestClient_OverTLS drives the real client against the fake API over TLS: the CA pin, the bearer
// header, a path prefix on the server URL, and the whole read-only lifecycle.
func TestClient_OverTLS(t *testing.T) {
	fake := newFakeAPIServer()
	var sawAuth, sawPath string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		sawPath = r.URL.Path
		r.URL.Path = strings.TrimPrefix(r.URL.Path, "/k8s")
		fake.ServeHTTP(w, r)
	}))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0) // the wrong-CA handshake below is expected
	defer srv.Close()
	c, err := NewClient(Conn{Server: srv.URL + "/k8s/", CAData: serverCAData(srv), Token: "admin-bearer", Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	mustEnsure(t, c, defaultOpts)
	if sawAuth != "Bearer admin-bearer" {
		t.Fatalf("Authorization = %q", sawAuth)
	}
	if sawPath != "/k8s"+bindingPath {
		t.Fatalf("path = %q, want the server prefix kept", sawPath)
	}
	tok, err := MintReadOnlyToken(ctx, c, defaultOpts, time.Hour)
	if err != nil || tok.Token != fake.token {
		t.Fatalf("mint over TLS: %v", err)
	}
	if err := RevokeReadOnlyAccess(ctx, c, defaultOpts); err != nil {
		t.Fatal(err)
	}

	// The wrong CA is a TLS failure, and the error does not carry the token.
	wrong, err := NewClient(Conn{Server: srv.URL, CAData: testCAData, Token: "admin-bearer"})
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = wrong.Do(ctx, http.MethodGet, "/api", "", nil)
	if !errors.Is(err, ErrKubeAPI) || strings.Contains(err.Error(), "admin-bearer") {
		t.Fatalf("wrong CA: err = %v", err)
	}
	// A path that is not an absolute API path is refused before any request.
	for _, p := range []string{"api/v1", "https://evil.example/api", "//evil.example/api", "/%zz"} {
		if _, _, err := c.Do(ctx, http.MethodGet, p, "", nil); !errors.Is(err, ErrKubeAPI) {
			t.Errorf("path %q: err = %v", p, err)
		}
	}
	// A bad method is a request-build error.
	if _, _, err := c.Do(ctx, "BAD METHOD", "/api", "", nil); !errors.Is(err, ErrKubeAPI) {
		t.Errorf("bad method: err = %v", err)
	}
}

// TestClient_DoesNotFollowRedirects: a redirect would replay the bearer to an unpinned host.
func TestClient_DoesNotFollowRedirects(t *testing.T) {
	var followed bool
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/elsewhere" {
			followed = true
		}
		http.Redirect(w, r, "/elsewhere", http.StatusFound)
	}))
	defer srv.Close()
	c, _ := NewClient(Conn{Server: srv.URL, CAData: serverCAData(srv), Token: "t"})
	code, _, err := c.Do(context.Background(), http.MethodGet, "/api", "", nil)
	if err != nil || code != http.StatusFound || followed {
		t.Fatalf("code = %d, err = %v, followed = %v", code, err, followed)
	}
}

// TestClient_PresentsClientCertificate: the cert credential is presented in the TLS handshake and
// no Authorization header is sent.
func TestClient_PresentsClientCertificate(t *testing.T) {
	certB64, keyB64, cert := genClientPair(t)
	var gotCN, gotAuth string
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.TLS.PeerCertificates) > 0 {
			gotCN = r.TLS.PeerCertificates[0].Subject.CommonName
		}
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	srv.TLS = &tls.Config{ClientAuth: tls.RequireAnyClientCert}
	srv.StartTLS()
	defer srv.Close()
	c, err := NewClient(Conn{Server: srv.URL, CAData: serverCAData(srv), ClientCertData: certB64, ClientKeyData: keyB64})
	if err != nil {
		t.Fatal(err)
	}
	if code, _, err := c.Do(context.Background(), http.MethodGet, "/version", "", nil); err != nil || code != 200 {
		t.Fatalf("code = %d, err = %v", code, err)
	}
	if gotCN != cert.Subject.CommonName || gotAuth != "" {
		t.Fatalf("CN = %q, Authorization = %q", gotCN, gotAuth)
	}
}

// TestAPIError renders the reason and a bounded message, strips the query, and unwraps.
func TestAPIError(t *testing.T) {
	long := strings.Repeat("m", 1000)
	e := apiError("PATCH", "/apis/x?fieldManager=alethia&force=true", 403, []byte(`{"reason":"Forbidden","message":"`+long+`"}`))
	if e.Path != "/apis/x" || e.Reason != "Forbidden" || len(e.Message) > maxStatusMessage+len("…") {
		t.Fatalf("%+v", e)
	}
	if !errors.Is(e, ErrKubeAPI) || !strings.HasPrefix(e.Error(), "PATCH /apis/x: HTTP 403 Forbidden: mmm") {
		t.Fatalf("Error() = %q", e.Error())
	}
	bare := apiError("GET", "/x", 500, []byte("not json"))
	if bare.Error() != "GET /x: HTTP 500" {
		t.Fatalf("Error() = %q", bare.Error())
	}
}
