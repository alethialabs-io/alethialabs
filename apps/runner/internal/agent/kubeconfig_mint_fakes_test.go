// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/kubeaccess"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Fakes for the MINT_KUBECONFIG tests. kubeaccess's own fake API server (#5304) lives in a _test.go
// file of that package and is not importable, so this is the minimal one the runner's tests need:
// server-side apply answers with what was applied, and TokenRequest answers with a token that expires
// exactly when asked. Failure injection is per path substring.

// fakeKube is an in-memory Kubernetes API for the read-only tier.
type fakeKube struct {
	mu sync.Mutex
	// token is what TokenRequest answers with.
	token string
	// failOn maps a path substring to the status code that request answers with.
	failOn map[string]int
	// failBody is the body a failing answer carries (a Status whose message may echo anything).
	failBody string
	// transportErr, when set, makes every request fail before any answer.
	transportErr error
	// calls records "METHOD path" for every request.
	calls []string
	// tokenSeconds is the expirationSeconds the last TokenRequest asked for.
	tokenSeconds int64
}

// Do implements kubeaccess.KubeAPI.
func (f *fakeKube) Do(_ context.Context, method, path, _ string, body []byte) (int, []byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, method+" "+path)
	if f.transportErr != nil {
		return 0, nil, f.transportErr
	}
	for sub, code := range f.failOn {
		if strings.Contains(path, sub) {
			return code, []byte(f.failBody), nil
		}
	}
	switch {
	case method == http.MethodPatch:
		return http.StatusOK, body, nil
	case method == http.MethodPost && strings.HasSuffix(path, "/token"):
		var req struct {
			Spec struct {
				ExpirationSeconds int64 `json:"expirationSeconds"`
			} `json:"spec"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			return http.StatusBadRequest, nil, nil
		}
		f.tokenSeconds = req.Spec.ExpirationSeconds
		var resp struct {
			Status struct {
				Token               string `json:"token"`
				ExpirationTimestamp string `json:"expirationTimestamp"`
			} `json:"status"`
		}
		resp.Status.Token = f.token
		resp.Status.ExpirationTimestamp = time.Now().Add(time.Duration(req.Spec.ExpirationSeconds) * time.Second).UTC().Format(time.RFC3339)
		out, _ := json.Marshal(resp)
		return http.StatusCreated, out, nil
	case method == http.MethodDelete:
		return http.StatusOK, []byte(`{}`), nil
	default:
		return http.StatusNotFound, nil, nil
	}
}

// called reports whether any request path contains sub.
func (f *fakeKube) called(sub string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if strings.Contains(c, sub) {
			return true
		}
	}
	return false
}

// testPKI is a CA plus one client certificate signed by it, all in kubeconfig's base64-PEM form.
type testPKI struct {
	caData   string
	certData string
	keyData  string
	notAfter time.Time
}

// newTestPKI builds a CA and a client certificate valid for lifetime.
func newTestPKI(t *testing.T, lifetime time.Duration) testPKI {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Truncate(time.Second)
	caTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test-ca"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(48 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, _ := x509.ParseCertificate(caDER)
	clientKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	notAfter := now.Add(lifetime)
	clTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "admin", Organization: []string{"system:masters"}},
		NotBefore: now.Add(-time.Minute), NotAfter: notAfter,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, KeyUsage: x509.KeyUsageDigitalSignature,
	}
	clDER, err := x509.CreateCertificate(rand.Reader, clTmpl, caCert, &clientKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(clientKey)
	if err != nil {
		t.Fatal(err)
	}
	b64 := func(typ string, der []byte) string {
		return base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: der}))
	}
	return testPKI{
		caData:   b64("CERTIFICATE", caDER),
		certData: b64("CERTIFICATE", clDER),
		keyData:  b64("EC PRIVATE KEY", keyDER),
		notAfter: notAfter,
	}
}

// certKubeconfigYAML renders the kubeconfig shape Talos and ACK return.
func certKubeconfigYAML(server string, p testPKI) string {
	return "apiVersion: v1\nkind: Config\ncurrent-context: admin@c1\nclusters:\n- name: c1\n  cluster:\n    server: " + server +
		"\n    certificate-authority-data: " + p.caData +
		"\nusers:\n- name: admin@c1\n  user:\n    client-certificate-data: " + p.certData +
		"\n    client-key-data: " + p.keyData +
		"\ncontexts:\n- name: admin@c1\n  context:\n    cluster: c1\n    user: admin@c1\n"
}

// noDNS is a resolver that never answers: every test server is an IP literal, so a lookup means a
// test is resolving something it should not.
type noDNS struct{}

// LookupNetIP implements kubeaccess.Resolver.
func (noDNS) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return nil, errors.New("no DNS in tests")
}

// mintTestAPI is covRunAPI plus the kubeconfig mint channel.
type mintTestAPI struct {
	*covRunAPI
	spec    types.RunnerKubeconfigMintSpec
	specErr error
	postErr error

	pmu    sync.Mutex
	posted []types.RunnerKubeconfigMintResult
}

// FetchKubeconfigMintSpec returns the configured spec or error.
func (a *mintTestAPI) FetchKubeconfigMintSpec(string) (types.RunnerKubeconfigMintSpec, error) {
	return a.spec, a.specErr
}

// PostKubeconfigMintResult records the result and validates it the way the real client does.
func (a *mintTestAPI) PostKubeconfigMintResult(_ string, r types.RunnerKubeconfigMintResult) error {
	if err := r.Validate(); err != nil {
		return err
	}
	a.pmu.Lock()
	a.posted = append(a.posted, r)
	a.pmu.Unlock()
	return a.postErr
}

// results returns a copy of what was posted.
func (a *mintTestAPI) results() []types.RunnerKubeconfigMintResult {
	a.pmu.Lock()
	defer a.pmu.Unlock()
	return append([]types.RunnerKubeconfigMintResult(nil), a.posted...)
}

// Fixed ids for the seal binding (canonical lowercase UUIDs, as Seal requires).
const (
	testMintID    = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b"
	testClusterID = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d"
)

// mintFixture is one configured mint: the client key, the API fake, the kube fake and the seams.
type mintFixture struct {
	t        *testing.T
	key      *kubeaccess.ClientKey
	api      *mintTestAPI
	kube     *fakeKube
	seams    mintSeams
	pki      testPKI
	ackMins  []int
	kubeConn kubeaccess.Conn
	// cloudToken is what the bearer clouds' token minters return.
	cloudToken  string
	cloudExpiry time.Time
}

// newMintFixture builds a fixture whose every cloud answers successfully with `secret` as the bearer
// token, the SA token and inside the talosconfig, so a test can look for it anywhere.
func newMintFixture(t *testing.T, tier types.KubeconfigMintTier, shape types.KubeconfigMintShape, secret string) *mintFixture {
	t.Helper()
	key, err := kubeaccess.GenerateClientKey()
	if err != nil {
		t.Fatal(err)
	}
	f := &mintFixture{
		t:    t,
		key:  key,
		kube: &fakeKube{token: "sa-" + secret},
		// Inside the 8h admin cap, so the success paths mint. A cert that outlives the cap (the managed
		// hetzner template's 24h) is TestMintKubeconfig_AdminLifetimeCap's subject.
		pki:         newTestPKI(t, time.Hour),
		cloudToken:  "cloud-" + secret,
		cloudExpiry: time.Now().Add(14 * time.Minute).Truncate(time.Second),
	}
	f.api = &mintTestAPI{
		covRunAPI: newCovRunAPI(),
		spec: types.RunnerKubeconfigMintSpec{
			MintID: testMintID, ClusterID: testClusterID, Tier: tier, Shape: shape,
			TTLSeconds: 3600, ClientPublicKey: key.PublicKey(),
		},
	}
	f.api.talosFetchFn = func(string) (string, error) { return "context: c1 # talosconfig " + secret, nil }
	conn := func() (string, string, error) { return "https://203.0.113.10:6443", f.pki.caData, nil }
	tok := func() (string, time.Time, error) { return f.cloudToken, f.cloudExpiry, nil }
	f.seams = mintSeams{
		readOutputs: func(context.Context, *Runner, *Job, *types.ProjectConfig, *JobLogger, *JobLogger) (map[string]any, error) {
			return map[string]any{"eks_cluster_name": map[string]any{"value": "c1"}}, nil
		},
		eksConn:  func(context.Context, string, string) (string, string, error) { return conn() },
		eksToken: func(context.Context, string, string) (string, time.Time, error) { return tok() },
		gkeConn: func(context.Context, *types.ProjectConfig, string) (string, string, error) {
			return "203.0.113.10:6443", f.pki.caData, nil // GKE answers a bare host
		},
		gkeToken: func(context.Context) (string, time.Time, error) { return tok() },
		aksConn:  func(context.Context, *types.ProjectConfig, string) (string, string, error) { return conn() },
		aksToken: func(context.Context) (string, time.Time, error) { return tok() },
		ackKubeconfig: func(_ context.Context, _, _ string, minutes int) (string, error) {
			f.ackMins = append(f.ackMins, minutes)
			p := newTestPKI(t, time.Duration(minutes)*time.Minute)
			f.pki = p
			return certKubeconfigYAML("https://203.0.113.10:6443", p), nil
		},
		talosKubeconfig: func(context.Context, string) ([]byte, error) {
			return []byte(certKubeconfigYAML("https://203.0.113.10:6443", f.pki)), nil
		},
		newKube: func(c kubeaccess.Conn) (kubeaccess.KubeAPI, error) {
			f.kubeConn = c
			return f.kube, nil
		},
		lookupIP: func(context.Context, string) ([]netip.Addr, error) { return nil, errors.New("no DNS in tests") },
		resolver: noDNS{},
	}
	return f
}

// use installs the fixture's seams for the test.
func (f *mintFixture) use(t *testing.T) {
	t.Helper()
	prev := kubeconfigMintSeams
	kubeconfigMintSeams = f.seams
	t.Cleanup(func() { kubeconfigMintSeams = prev })
}

// mintSnapshot is a config snapshot for provider.
func mintSnapshot(provider string) map[string]any {
	return map[string]any{
		"provider":          provider,
		"region":            "eu-central-1",
		"project_name":      "Web Shop",
		"environment_stage": "production",
		"cluster":           map[string]any{"cluster_name": "c1"},
	}
}

// open opens a ready result with the fixture's key.
func (f *mintFixture) open(t *testing.T, r types.RunnerKubeconfigMintResult) types.KubeconfigMintCredential {
	t.Helper()
	if r.Status != types.KubeconfigMintStatusReady {
		t.Fatalf("result is %q (reason %q), want ready", r.Status, r.Reason)
	}
	plain, err := f.key.Open(r.Sealed, testMintID, testClusterID)
	if err != nil {
		t.Fatalf("open sealed result: %v", err)
	}
	var cred types.KubeconfigMintCredential
	dec := json.NewDecoder(strings.NewReader(string(plain)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cred); err != nil {
		t.Fatalf("decode credential: %v", err)
	}
	if err := cred.Validate(); err != nil {
		t.Fatalf("opened credential is invalid: %v", err)
	}
	return cred
}

// urlTransportErr is a transport failure shaped as net/http returns it.
func urlTransportErr(secret string) error {
	return &url.Error{Op: "Patch", URL: "https://203.0.113.10:6443/api?x=" + secret, Err: errors.New("connection refused " + secret)}
}
