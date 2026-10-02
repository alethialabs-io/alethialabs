// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FREE, every-PR proof of the kubeconfig-mint proof's logic (#5287) — no build tag, no cloud, no
// cluster. The live half (t2_kubeconfig_mint_run_test.go) only orchestrates; every decision it makes
// is one of the functions below, so this is where its verdicts are pinned.
package e2e

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
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// fakeKube answers kubeDoer from a table keyed by "METHOD path".
type fakeKube struct {
	answers map[string]fakeAnswer
	calls   []string
}

// fakeAnswer is one canned API answer.
type fakeAnswer struct {
	code int
	body string
	err  error
}

// Do returns the canned answer for the request, or a 404 for anything unlisted.
func (f *fakeKube) Do(_ context.Context, method, path, _ string, _ []byte) (int, []byte, error) {
	key := method + " " + path
	f.calls = append(f.calls, key)
	a, ok := f.answers[key]
	if !ok {
		return http.StatusNotFound, []byte(`{"kind":"Status","reason":"NotFound"}`), nil
	}
	return a.code, []byte(a.body), a.err
}

const (
	forbiddenBody = `{"kind":"Status","status":"Failure","reason":"Forbidden","code":403}`
	nodeList      = `{"kind":"NodeList","items":[{"metadata":{"name":"n1"}}]}`
	podList       = `{"kind":"PodList","items":[{"metadata":{"name":"p1"}},{"metadata":{"name":"p2"}}]}`
)

// readOnlyRBAC is a correct read-only tier: reads allowed, writes and secrets refused.
func readOnlyRBAC(suffix string) *fakeKube {
	cm := "alethia-kc-ro-" + suffix
	return &fakeKube{answers: map[string]fakeAnswer{
		"GET /api/v1/nodes":                                  {code: 200, body: nodeList},
		"GET /api/v1/pods?limit=200":                         {code: 200, body: podList},
		"POST /api/v1/namespaces/default/configmaps":         {code: 403, body: forbiddenBody},
		"DELETE /api/v1/namespaces/default/configmaps/" + cm: {code: 403, body: forbiddenBody},
		"GET /api/v1/namespaces/kube-system/secrets":         {code: 403, body: forbiddenBody},
	}}
}

// adminRBAC is a correct admin tier.
func adminRBAC(suffix string) *fakeKube {
	ns, cm := "alethia-kc-e2e-"+suffix, "alethia-kc-admin-"+suffix
	return &fakeKube{answers: map[string]fakeAnswer{
		"GET /api/v1/nodes":                                     {code: 200, body: nodeList},
		"POST /api/v1/namespaces":                               {code: 201, body: `{"kind":"Namespace"}`},
		"POST /api/v1/namespaces/" + ns + "/configmaps":         {code: 201, body: `{"kind":"ConfigMap"}`},
		"DELETE /api/v1/namespaces/" + ns + "/configmaps/" + cm: {code: 200, body: `{"kind":"Status","status":"Success"}`},
		"DELETE /api/v1/namespaces/" + ns:                       {code: 200, body: `{"kind":"Namespace"}`},
	}}
}

// TestClassifyKubeAnswer pins the classifier on the STATUS CODE: 403 is a refusal, 401 is not, and a
// transport error is never a refusal whatever code came with it.
func TestClassifyKubeAnswer(t *testing.T) {
	for _, tc := range []struct {
		name   string
		code   int
		body   string
		err    error
		want   kubeOutcome
		reason string
	}{
		{"403 is refused", 403, forbiddenBody, nil, kubeRefused, "Forbidden"},
		{"403 with no Status body is still refused", 403, ``, nil, kubeRefused, ""},
		{"200 is allowed", 200, nodeList, nil, kubeAllowed, ""},
		{"201 is allowed", 201, `{}`, nil, kubeAllowed, ""},
		{"401 is not a refusal", 401, `{"reason":"Unauthorized"}`, nil, kubeUnauthenticated, "Unauthorized"},
		{"404 is an error", 404, `{"reason":"NotFound"}`, nil, kubeError, "NotFound"},
		{"500 is an error", 500, ``, nil, kubeError, ""},
		{"a Forbidden reason under a 200 is allowed", 200, `{"reason":"Forbidden"}`, nil, kubeAllowed, "Forbidden"},
		{"transport error", 0, ``, errors.New("dial tcp: i/o timeout"), kubeError, ""},
		{"transport error beside a 403", 403, forbiddenBody, errors.New("read: reset"), kubeError, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, reason := classifyKubeAnswer(tc.code, []byte(tc.body), tc.err)
			if got != tc.want || reason != tc.reason {
				t.Fatalf("classifyKubeAnswer(%d) = (%s, %q), want (%s, %q)", tc.code, got, reason, tc.want, tc.reason)
			}
		})
	}
}

// TestCheckPasses pins the verdict: a refused read-only write is a PASS, an allowed one a FAIL, and
// so is any write that was neither refused nor allowed.
func TestCheckPasses(t *testing.T) {
	for _, tc := range []struct {
		want, got kubeOutcome
		pass      bool
	}{
		{kubeRefused, kubeRefused, true},
		{kubeRefused, kubeAllowed, false},
		{kubeRefused, kubeError, false},
		{kubeRefused, kubeUnauthenticated, false},
		{kubeAllowed, kubeAllowed, true},
		{kubeAllowed, kubeRefused, false},
		{kubeAllowed, kubeUnauthenticated, false},
		{kubeAllowed, kubeError, false},
		{kubeOutcome("bogus"), kubeAllowed, false},
	} {
		if got := checkPasses(tc.want, tc.got); got != tc.pass {
			t.Errorf("checkPasses(want %s, got %s) = %t, want %t", tc.want, tc.got, got, tc.pass)
		}
	}
}

// TestReadOnlyTierAgainstACorrectRBAC drives the real read-only plan through a fake API server that
// behaves like the alethia:view role: every check passes, and every write was actually SENT.
func TestReadOnlyTierAgainstACorrectRBAC(t *testing.T) {
	kube := readOnlyRBAC("abc")
	res := runKubeChecks(context.Background(), kube, readOnlyChecks("abc"))
	for _, r := range res {
		if !r.Pass {
			t.Errorf("%s did not pass: %+v", r.Name, r)
		}
	}
	for _, want := range []string{"POST /api/v1/namespaces/default/configmaps", "GET /api/v1/namespaces/kube-system/secrets"} {
		found := false
		for _, c := range kube.calls {
			found = found || c == want
		}
		if !found {
			t.Errorf("the read-only plan never sent %q — a refusal it did not ask for proves nothing", want)
		}
	}
	tier := KubeconfigMintTier{Tier: mintTierReadonly, Shape: mintShapeStatic, Minted: true, Checks: res, ExpiryWithinTTL: ptr(true)}
	if finishTier(&tier); tier.Verdict != "PASS" {
		t.Errorf("a correct read-only tier = %s, want PASS", tier.Verdict)
	}
}

// TestReadOnlyTierThatCanWriteFails is the inverse: the same plan against a tier that ALLOWS the
// write (the defect this proof exists for) fails that check and the tier.
func TestReadOnlyTierThatCanWriteFails(t *testing.T) {
	for _, leak := range []struct{ key, check string }{
		{"POST /api/v1/namespaces/default/configmaps", "create-configmap"},
		{"DELETE /api/v1/namespaces/default/configmaps/alethia-kc-ro-abc", "delete-configmap"},
		{"GET /api/v1/namespaces/kube-system/secrets", "list-secrets"},
	} {
		t.Run(leak.check, func(t *testing.T) {
			kube := readOnlyRBAC("abc")
			kube.answers[leak.key] = fakeAnswer{code: 200, body: `{"kind":"List","items":[]}`}
			res := runKubeChecks(context.Background(), kube, readOnlyChecks("abc"))
			for _, r := range res {
				if r.Name == leak.check && r.Pass {
					t.Fatalf("an ALLOWED %s passed as if refused: %+v", leak.check, r)
				}
			}
			tier := KubeconfigMintTier{Tier: mintTierReadonly, Shape: mintShapeStatic, Minted: true, Checks: res, ExpiryWithinTTL: ptr(true)}
			if finishTier(&tier); tier.Verdict != "FAIL" {
				t.Errorf("a read-only tier that can %s = %s, want FAIL", leak.check, tier.Verdict)
			}
		})
	}
}

// TestReadOnlyRefusalMustBeA403 — a 401 or a 404 on a write is not RBAC refusing it.
func TestReadOnlyRefusalMustBeA403(t *testing.T) {
	kube := readOnlyRBAC("abc")
	kube.answers["POST /api/v1/namespaces/default/configmaps"] = fakeAnswer{code: 401, body: `{"reason":"Unauthorized"}`}
	res := runKubeChecks(context.Background(), kube, readOnlyChecks("abc"))
	if res[2].Name != "create-configmap" || res[2].Pass || res[2].Outcome != string(kubeUnauthenticated) {
		t.Fatalf("a 401 on the write must fail as unauthenticated, got %+v", res[2])
	}
}

// TestAllowedEmptyListFails: a read that is allowed and returns nothing proves the call, not the read.
func TestAllowedEmptyListFails(t *testing.T) {
	kube := readOnlyRBAC("abc")
	kube.answers["GET /api/v1/nodes"] = fakeAnswer{code: 200, body: `{"kind":"NodeList","items":[]}`}
	res := runKubeChecks(context.Background(), kube, readOnlyChecks("abc"))
	if res[0].Pass || res[0].Items == nil || *res[0].Items != 0 {
		t.Fatalf("an empty node list must fail list-nodes, got %+v", res[0])
	}
}

// TestAdminTier pins the admin plan: all five allowed passes; a refused write fails.
func TestAdminTier(t *testing.T) {
	res := runKubeChecks(context.Background(), adminRBAC("abc"), adminChecks("abc"))
	tier := KubeconfigMintTier{Tier: mintTierAdmin, Shape: mintShapeStatic, Minted: true, Checks: res}
	if finishTier(&tier); tier.Verdict != "PASS" {
		t.Fatalf("a correct admin tier = %s: %+v", tier.Verdict, res)
	}
	kube := adminRBAC("abc")
	kube.answers["POST /api/v1/namespaces/alethia-kc-e2e-abc/configmaps"] = fakeAnswer{code: 403, body: forbiddenBody}
	res = runKubeChecks(context.Background(), kube, adminChecks("abc"))
	tier = KubeconfigMintTier{Tier: mintTierAdmin, Shape: mintShapeStatic, Minted: true, Checks: res}
	if finishTier(&tier); tier.Verdict != "FAIL" {
		t.Fatalf("an admin tier refused its write = %s, want FAIL", tier.Verdict)
	}
}

// ptr returns a pointer to v.
func ptr[T any](v T) *T { return &v }

// passingSummary is a summary whose every part passes.
func passingSummary() KubeconfigMintSummary {
	pass := []KubeCheckResult{{Name: "list-nodes", Want: "allowed", Outcome: "allowed", Pass: true}}
	return KubeconfigMintSummary{
		Enabled: true, Provider: "hetzner", Driver: kubeconfigMintDriverRunner, PrivateEndpoint: ptr(false), CanaryClean: true,
		Tiers: []KubeconfigMintTier{
			{Tier: mintTierReadonly, Shape: mintShapeStatic, Minted: true, Checks: pass, ExpiryWithinTTL: ptr(true), Verdict: "PASS", ExpiresAt: "2026-10-02T10:15:00Z", ExpirySource: expiryFromTokenClaim},
			{Tier: mintTierAdmin, Shape: mintShapeStatic, Minted: true, Checks: pass, Verdict: "PASS"},
		},
	}
}

// TestSummaryPasses pins every way the whole proof fails.
func TestSummaryPasses(t *testing.T) {
	if !summaryPasses(passingSummary()) {
		t.Fatal("the passing summary does not pass")
	}
	for name, mutate := range map[string]func(*KubeconfigMintSummary){
		"disabled":             func(s *KubeconfigMintSummary) { s.Enabled = false },
		"a failed stage":       func(s *KubeconfigMintSummary) { s.FailedStage = mintStageMint },
		"an unclean canary":    func(s *KubeconfigMintSummary) { s.CanaryClean = false },
		"no admin tier":        func(s *KubeconfigMintSummary) { s.Tiers = s.Tiers[:1] },
		"no read-only tier":    func(s *KubeconfigMintSummary) { s.Tiers = s.Tiers[1:] },
		"read-only not minted": func(s *KubeconfigMintSummary) { s.Tiers[0].Minted = false },
		"read-only expiry past the TTL": func(s *KubeconfigMintSummary) {
			s.Tiers[0].ExpiryWithinTTL = ptr(false)
		},
		"read-only expiry never checked": func(s *KubeconfigMintSummary) { s.Tiers[0].ExpiryWithinTTL = nil },
		"a failed check":                 func(s *KubeconfigMintSummary) { s.Tiers[1].Checks[0].Pass = false },
		"a tier with no checks":          func(s *KubeconfigMintSummary) { s.Tiers[1].Checks = nil },
		"a failing exec tier": func(s *KubeconfigMintSummary) {
			s.Tiers = append(s.Tiers, KubeconfigMintTier{Tier: mintTierReadonly, Shape: mintShapeExec, Minted: false})
		},
	} {
		t.Run(name, func(t *testing.T) {
			s := passingSummary()
			s.Tiers[1].Checks = append([]KubeCheckResult(nil), s.Tiers[1].Checks...)
			mutate(&s)
			if summaryPasses(s) {
				t.Errorf("a summary with %s passed", name)
			}
		})
	}
}

// TestSummarizeKubeconfigMint pins the verdict line's shape: icon, driver, tiers, privacy, canary,
// and the failed stage when there is one.
func TestSummarizeKubeconfigMint(t *testing.T) {
	line := summarizeKubeconfigMint(passingSummary())
	for _, want := range []string{"✅ kubeconfig-mint (runner-channel)", "readonly/static PASS", "admin/static PASS", "private_endpoint=false", "canary clean=true", "via token-exp-claim"} {
		if !strings.Contains(line, want) {
			t.Errorf("verdict %q lacks %q", line, want)
		}
	}
	s := passingSummary()
	s.FailedStage, s.FailedDetail = mintStageMint, "admin: the mint ended failed"
	s.Tiers[1] = KubeconfigMintTier{Tier: mintTierAdmin, Shape: mintShapeStatic, MintStatus: "failed",
		FailedReason: "The cluster was not found in the cloud account.", Verdict: "FAIL"}
	line = summarizeKubeconfigMint(s)
	for _, want := range []string{"❌", "FAILED at stage mint", "mint failed: The cluster was not found in the cloud account."} {
		if !strings.Contains(line, want) {
			t.Errorf("failing verdict %q lacks %q", line, want)
		}
	}
	if got := summarizeKubeconfigMint(KubeconfigMintSummary{}); !strings.Contains(got, "skipped") {
		t.Errorf("a disabled summary reads %q, want it to say skipped", got)
	}
}

// fakeJWT builds an unsigned JWT carrying exp.
func fakeJWT(exp time.Time) string {
	enc := base64.RawURLEncoding
	payload, _ := json.Marshal(map[string]any{"exp": exp.Unix(), "sub": "system:serviceaccount:alethia-system:alethia-view"})
	return enc.EncodeToString([]byte(`{"alg":"RS256"}`)) + "." + enc.EncodeToString(payload) + ".c2lnbmF0dXJlLXNpZ25hdHVyZQ"
}

// fakeCert returns a base64 PEM certificate and key with the given NotAfter.
func fakeCert(t *testing.T, notAfter time.Time) (certB64, keyB64 string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "admin"},
		NotBefore: notAfter.Add(-time.Hour), NotAfter: notAfter}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kder, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certB64 = base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	keyB64 = base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}))
	return certB64, keyB64
}

// TestCredentialExpiry pins where an expiry is read from, best source first.
func TestCredentialExpiry(t *testing.T) {
	exp := time.Date(2026, 10, 2, 10, 15, 0, 0, time.UTC)
	reported := exp.Add(time.Hour)
	if got, src := credentialExpiry(staticKubeconfig{Token: fakeJWT(exp)}, reported); !got.Equal(exp) || src != expiryFromTokenClaim {
		t.Errorf("JWT: got (%s, %s), want the token's own exp", got, src)
	}
	cert, key := fakeCert(t, exp)
	if got, src := credentialExpiry(staticKubeconfig{ClientCertData: cert, ClientKeyData: key}, reported); !got.Equal(exp) || src != expiryFromCertNotAfter {
		t.Errorf("cert: got (%s, %s), want NotAfter", got, src)
	}
	if got, src := credentialExpiry(staticKubeconfig{Token: "k8s-aws-v1.opaque-presigned-url"}, reported); !got.Equal(reported) || src != expiryFromRunner {
		t.Errorf("opaque token: got (%s, %s), want the runner's report", got, src)
	}
	if got, src := credentialExpiry(staticKubeconfig{Token: "ya29.opaque"}, time.Time{}); !got.IsZero() || src != expiryUnknown {
		t.Errorf("opaque token and no report: got (%s, %s), want unknown", got, src)
	}
	for _, bad := range []string{"a.b", "a.!!!.c", "a." + base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"x"}`)) + ".c",
		"a." + base64.RawURLEncoding.EncodeToString([]byte(`{"exp":-5}`)) + ".c"} {
		if _, ok := jwtExpiry(bad); ok {
			t.Errorf("jwtExpiry(%q) read an expiry from a malformed token", bad)
		}
	}
	if _, ok := certNotAfter("not base64 !!"); ok {
		t.Error("certNotAfter read a malformed certificate")
	}
}

// TestReadOnlyExpiryOK pins the lifetime rule: inside TTL+5m and still valid passes; past it, already
// expired, or unreadable fails.
func TestReadOnlyExpiryOK(t *testing.T) {
	req := time.Date(2026, 10, 2, 10, 0, 0, 0, time.UTC)
	now := req.Add(time.Minute)
	ttl := 15 * time.Minute
	for _, tc := range []struct {
		name    string
		exp     time.Time
		src     string
		wantErr bool
	}{
		{"at the TTL", req.Add(ttl), expiryFromTokenClaim, false},
		{"exactly TTL+skew", req.Add(ttl + kubeconfigMintExpirySkew), expiryFromTokenClaim, false},
		{"one second past TTL+skew", req.Add(ttl + kubeconfigMintExpirySkew + time.Second), expiryFromTokenClaim, true},
		{"an hour (the TTL ignored)", req.Add(time.Hour), expiryFromTokenClaim, true},
		{"already expired", now.Add(-time.Second), expiryFromTokenClaim, true},
		{"unknown", time.Time{}, expiryUnknown, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := readOnlyExpiryOK(tc.exp, tc.src, req, now, ttl)
			if (err != nil) != tc.wantErr {
				t.Fatalf("readOnlyExpiryOK = %v, wantErr %t", err, tc.wantErr)
			}
		})
	}
}

// TestParseStaticKubeconfig pins what a static file must hold, and that no error quotes it.
func TestParseStaticKubeconfig(t *testing.T) {
	const token = "CANARY-kc-e2e-token-0123456789abcdef"
	ca := base64.StdEncoding.EncodeToString([]byte("-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n"))
	file := func(user string) []byte {
		return []byte("apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: https://1.2.3.4:6443\n    certificate-authority-data: " + ca +
			"\nusers:\n- name: u\n  user:\n" + user + "\ncontexts:\n- name: x\n  context: {cluster: c, user: u}\ncurrent-context: x\n")
	}
	k, err := parseStaticKubeconfig(file("    token: " + token))
	if err != nil || k.Token != token || k.Server != "https://1.2.3.4:6443" || k.credentialKind() != "bearer-token" {
		t.Fatalf("token file = (%v, %v)", k, err)
	}
	if strings.Contains(fmt.Sprintf("%v %+v %s", k, k, k), token) {
		t.Error("printing a staticKubeconfig leaked its token")
	}
	cert, key := fakeCert(t, time.Now().Add(time.Hour))
	if k, err := parseStaticKubeconfig(file("    client-certificate-data: " + cert + "\n    client-key-data: " + key)); err != nil || k.credentialKind() != "client-certificate" {
		t.Fatalf("cert file = (%v, %v)", k, err)
	}
	for name, user := range map[string]string{
		"exec plugin":      "    exec: {command: alethia, apiVersion: client.authentication.k8s.io/v1}",
		"two credentials":  "    token: " + token + "\n    client-certificate-data: " + cert + "\n    client-key-data: " + key,
		"no credential":    "    {}",
		"cert without key": "    client-certificate-data: " + cert,
	} {
		_, err := parseStaticKubeconfig(file(user))
		if err == nil {
			t.Errorf("%s: parsed, want refused", name)
		} else if strings.Contains(err.Error(), token) {
			t.Errorf("%s: the error quotes the token", name)
		}
	}
	if _, err := parseStaticKubeconfig([]byte(":\t: not yaml " + token)); err == nil || strings.Contains(err.Error(), token) {
		t.Errorf("non-YAML = %v, want a refusal that does not quote the input", err)
	}
}

// TestCredentialSecrets pins the canary list: the token, the base64 key and the key material it
// decodes to — and nothing too short to be distinctive.
func TestCredentialSecrets(t *testing.T) {
	_, key := fakeCert(t, time.Now().Add(time.Hour))
	got := credentialSecrets("CANARY-kc-e2e-token-0123456789", key)
	if len(got) != 3 || got[0] != "CANARY-kc-e2e-token-0123456789" || got[1] != key {
		t.Fatalf("credentialSecrets = %d entries (%v), want token, key and key material", len(got), len(got))
	}
	raw, _ := base64.StdEncoding.DecodeString(key)
	if !strings.Contains(string(raw), got[2]) {
		t.Error("the key-material entry is not what the decoded PEM carries")
	}
	if got := credentialSecrets("short", ""); len(got) != 0 {
		t.Errorf("a short fragment was kept: %v", got)
	}
}

// TestWriteKubeconfigMintSummary pins the writer: it writes the verdict, and it REFUSES — writing
// nothing — a summary that carries a minted credential anywhere.
func TestWriteKubeconfigMintSummary(t *testing.T) {
	const canary = "CANARY-kc-e2e-token-0123456789abcdef"
	path := filepath.Join(t.TempDir(), "kubeconfig-mint-summary.json")
	if err := writeKubeconfigMintSummary(path, passingSummary(), []string{canary}); err != nil {
		t.Fatalf("write: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var back KubeconfigMintSummary
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("the summary is not JSON: %v", err)
	}
	if !strings.HasPrefix(back.Verdict, "✅ kubeconfig-mint") || len(back.Tiers) != 2 || back.Driver != kubeconfigMintDriverRunner {
		t.Errorf("round trip lost the verdict or tiers: %+v", back)
	}

	leaky := passingSummary()
	leaky.Tiers[1].Error = "kubectl said: Authorization: Bearer " + canary
	path2 := filepath.Join(t.TempDir(), "leak.json")
	if err := writeKubeconfigMintSummary(path2, leaky, []string{canary}); !errors.Is(err, errSummaryCarriesCredential) {
		t.Fatalf("a summary carrying the credential = %v, want errSummaryCarriesCredential", err)
	}
	if _, err := os.Stat(path2); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the refused summary was written anyway (stat err %v)", err)
	}
	if err := writeKubeconfigMintSummary(path2, leaky, []string{canary}); err == nil || strings.Contains(err.Error(), canary) {
		t.Errorf("the refusal must not quote the credential: %v", err)
	}
	// The refusal happens BEFORE the write: a file already at the path is left exactly as it was,
	// so the credential never touched the disk. (The read-back check alone would write it and then
	// delete it — this pins the first line of defence, not just the second.)
	if err := os.WriteFile(path2, []byte("previous summary\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_ = writeKubeconfigMintSummary(path2, leaky, []string{canary})
	if got, err := os.ReadFile(path2); err != nil || string(got) != "previous summary\n" {
		t.Errorf("a refused summary touched the file on disk (now %q, err %v)", got, err)
	}
}

// TestScanFilesForSecrets pins the canary over the bundle's sources.
func TestScanFilesForSecrets(t *testing.T) {
	const canary = "CANARY-kc-e2e-token-0123456789abcdef"
	dir := t.TempDir()
	clean, dirty := filepath.Join(dir, "runner.log"), filepath.Join(dir, "t2-test.log")
	if err := os.WriteFile(clean, []byte("Sealed the credential to the client's key and delivered it.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dirty, []byte("token: "+canary+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	scanned, hits, err := scanFilesForSecrets([]string{clean, dirty, filepath.Join(dir, "absent.log"), ""}, []string{canary})
	if err != nil {
		t.Fatal(err)
	}
	if len(scanned) != 2 || len(hits) != 1 || hits[0] != dirty {
		t.Fatalf("scanned %v hits %v, want both real files scanned and only the dirty one hit", scanned, hits)
	}
	if _, _, err := scanFilesForSecrets([]string{clean}, nil); err == nil {
		t.Error("a canary with nothing to look for vouched for the files")
	}
	if got := redactSecrets("Bearer "+canary+" end", []string{canary}); strings.Contains(got, canary) {
		t.Errorf("redactSecrets left the credential: %q", got)
	}
}

// TestKubeconfigMintEnabledByDefault pins the default and the off switch, and that the ladder term
// follows it.
func TestKubeconfigMintEnabledByDefault(t *testing.T) {
	for _, v := range T2BudgetScenarioEnv() {
		t.Setenv(v, "")
	}
	hasTerm := func() bool {
		b, err := ResolveT2Budget("hetzner", "ladder")
		if err != nil {
			t.Fatal(err)
		}
		for _, term := range b.Terms {
			if term.Scenario == "kubeconfig-mint" {
				return term.D == kubeconfigMintBudget
			}
		}
		return false
	}
	for _, v := range []string{"", "1", "true", "yes"} {
		t.Setenv(envKubeconfigMint, v)
		if !KubeconfigMintEnabled() || !hasTerm() {
			t.Errorf("%s=%q: enabled=%t term=%t, want both on", envKubeconfigMint, v, KubeconfigMintEnabled(), hasTerm())
		}
	}
	for _, v := range []string{"0", "false", "OFF", " no "} {
		t.Setenv(envKubeconfigMint, v)
		if KubeconfigMintEnabled() || hasTerm() {
			t.Errorf("%s=%q: enabled=%t term=%t, want both off", envKubeconfigMint, v, KubeconfigMintEnabled(), hasTerm())
		}
	}
}

// TestMintChannelRefusals pins the shim gate's answers to the console route's status codes.
func TestMintChannelRefusals(t *testing.T) {
	const runner = "r-1"
	job := func(mod func(*mintJobGate)) *mintJobGate {
		g := &mintJobGate{runnerID: runner, jobType: "MINT_KUBECONFIG", status: "PROCESSING"}
		if mod != nil {
			mod(g)
		}
		return g
	}
	for _, tc := range []struct {
		name string
		job  *mintJobGate
		want int
	}{
		{"missing", nil, 404},
		{"another runner's", job(func(g *mintJobGate) { g.runnerID = "r-2" }), 403},
		{"not a mint", job(func(g *mintJobGate) { g.jobType = "DEPLOY" }), 403},
		{"queued", job(func(g *mintJobGate) { g.status = "QUEUED" }), 403},
		{"finished", job(func(g *mintJobGate) { g.status = "SUCCESS" }), 403},
		{"claimed", job(func(g *mintJobGate) { g.status = "CLAIMED" }), 0},
		{"processing", job(nil), 0},
	} {
		if got, _ := mintGateRefusal(tc.job, runner); got != tc.want {
			t.Errorf("job %s = %d, want %d", tc.name, got, tc.want)
		}
	}
	for _, tc := range []struct {
		name string
		row  *mintRequestRow
		want int
	}{
		{"no row", nil, 404},
		{"window closed", &mintRequestRow{Status: "pending", ExpiredNow: true}, 410},
		{"swept", &mintRequestRow{Status: "expired"}, 410},
		{"already ready", &mintRequestRow{Status: "ready"}, 409},
		{"already failed", &mintRequestRow{Status: "failed"}, 409},
		{"pending", &mintRequestRow{Status: "pending"}, 0},
	} {
		if got, _ := mintRowRefusal(tc.row); got != tc.want {
			t.Errorf("row %s = %d, want %d", tc.name, got, tc.want)
		}
	}
}

// TestTalosconfigGateAdmitsADedicatedMint pins the talosconfig channel's mint arm, which mirrors the
// console route's isDedicatedMint: a read only, a dedicated environment only, linked by environment.
func TestTalosconfigGateAdmitsADedicatedMint(t *testing.T) {
	const runner = "r-1"
	mint := func(snap, env string) *talosJobRow {
		return &talosJobRow{runnerID: runner, jobType: "MINT_KUBECONFIG", status: "PROCESSING", snapshot: []byte(snap), environmentID: env}
	}
	if got := gateTalosconfigJob(mint(`{"provider":"hetzner"}`, "env-a"), runner, false); got.code != 0 || got.mintEnvironment != "env-a" || got.placementCluster != "" {
		t.Errorf("dedicated mint read = %+v, want admitted and linked to env-a", got)
	}
	if got := gateTalosconfigJob(mint(`{"provider":"hetzner","placement_mode":"dedicated"}`, "env-a"), runner, false); got.code != 0 {
		t.Errorf("explicit dedicated mint read = %+v, want admitted", got)
	}
	for name, tc := range map[string]struct {
		row   *talosJobRow
		write bool
		want  int
	}{
		"a mint may not write":           {mint(`{"provider":"hetzner"}`, "env-a"), true, 403},
		"a namespace mint is refused":    {mint(`{"provider":"hetzner","placement_mode":"namespace","cluster":{"cluster_name":"f"}}`, "env-a"), false, 403},
		"a vcluster mint is refused":     {mint(`{"provider":"hetzner","placement_mode":"vcluster","cluster":{"cluster_name":"f"}}`, "env-a"), false, 403},
		"a mint with no environment":     {mint(`{"provider":"hetzner"}`, ""), false, 409},
		"a finished mint":                {&talosJobRow{runnerID: runner, jobType: "MINT_KUBECONFIG", status: "SUCCESS", snapshot: []byte(`{"provider":"hetzner"}`), environmentID: "env-a"}, false, 403},
		"another runner's mint":          {&talosJobRow{runnerID: "r-2", jobType: "MINT_KUBECONFIG", status: "PROCESSING", snapshot: []byte(`{"provider":"hetzner"}`), environmentID: "env-a"}, false, 403},
		"a non-hetzner mint":             {mint(`{"provider":"aws"}`, "env-a"), false, 403},
		"a drift job still may not read": {&talosJobRow{runnerID: runner, jobType: "DETECT_DRIFT", status: "PROCESSING", snapshot: []byte(`{"provider":"hetzner"}`), environmentID: "env-a"}, false, 403},
	} {
		if got := gateTalosconfigJob(tc.row, runner, tc.write); got.code != tc.want {
			t.Errorf("%s = %d (%q), want %d", name, got.code, got.message, tc.want)
		}
	}
}

// TestControlPlane_TalosconfigMintRoundTrip drives a dedicated mint's read through the mux: it gets
// the talosconfig its OWN environment's deploy wrote, and never another environment's.
func TestControlPlane_TalosconfigMintRoundTrip(t *testing.T) {
	const talosA = "context: env-a\ncontexts: {}\n"
	const talosB = "context: env-b\ncontexts: {}\n"
	ded := []byte(`{"provider":"hetzner"}`)
	store := &fakeTalosStore{
		token: sha256Hex("tok"),
		jobs: map[string]*talosJobRow{
			"deploy-a": {runnerID: "r-1", jobType: "DEPLOY", status: "PROCESSING", snapshot: ded, environmentID: "env-a"},
			"deploy-b": {runnerID: "r-1", jobType: "DEPLOY", status: "PROCESSING", snapshot: ded, environmentID: "env-b"},
			"mint-a":   {runnerID: "r-1", jobType: "MINT_KUBECONFIG", status: "PROCESSING", snapshot: ded, environmentID: "env-a"},
			"mint-c":   {runnerID: "r-1", jobType: "MINT_KUBECONFIG", status: "PROCESSING", snapshot: ded, environmentID: "env-c"},
		},
		envs: map[string]string{"deploy-a": "env-a", "deploy-b": "env-b"},
	}
	h := (&ControlPlane{talosStore: store}).mux()
	do := func(method, job, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/jobs/"+job+"/talosconfig", strings.NewReader(body))
		req.Header.Set("X-Runner-ID", "r-1")
		req.Header.Set("X-Runner-Token", "tok")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	for job, tc := range map[string]string{"deploy-a": talosA, "deploy-b": talosB} {
		body, _ := json.Marshal(map[string]string{"talosconfig": tc})
		if rec := do(http.MethodPut, job, string(body)); rec.Code != http.StatusOK {
			t.Fatalf("%s PUT = %d", job, rec.Code)
		}
	}
	var got struct {
		Talosconfig *string `json:"talosconfig"`
	}
	rec := do(http.MethodGet, "mint-a", "")
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || got.Talosconfig == nil || *got.Talosconfig != talosA {
		t.Fatalf("mint-a GET = %d %q, want env-a's talosconfig", rec.Code, rec.Body.String())
	}
	if rec := do(http.MethodGet, "mint-c", ""); strings.TrimSpace(rec.Body.String()) != `{"talosconfig":null}` {
		t.Errorf("a mint whose environment wrote nothing read %q, want null", rec.Body.String())
	}
	if rec := do(http.MethodPut, "mint-a", `{"talosconfig":"x"}`); rec.Code != http.StatusForbidden {
		t.Errorf("mint PUT = %d, want 403", rec.Code)
	}
}

// fakeMintStore answers mintStore from memory and records what landed.
type fakeMintStore struct {
	jobs     map[string]*mintJobGate
	rows     map[string]*mintRequestRow // by job id
	deploys  map[string]string          // environment → latest successful DEPLOY
	landCode int
	landed   []types.RunnerKubeconfigMintResult
	err      error
}

// job returns the seeded gate, or nil.
func (f *fakeMintStore) job(_ context.Context, id string) (*mintJobGate, error) {
	return f.jobs[id], f.err
}

// rowForJob returns the seeded row, or nil.
func (f *fakeMintStore) rowForJob(_ context.Context, id string) (*mintRequestRow, error) {
	return f.rows[id], nil
}

// latestDeploy returns the seeded deploy for an environment.
func (f *fakeMintStore) latestDeploy(_ context.Context, env string) (string, error) {
	return f.deploys[env], nil
}

// land records the result and answers landCode (200 when unset).
func (f *fakeMintStore) land(_ context.Context, _, _, _, _ string, r types.RunnerKubeconfigMintResult) (int, string) {
	f.landed = append(f.landed, r)
	if f.landCode != 0 {
		return f.landCode, "refused"
	}
	return http.StatusOK, ""
}

// TestControlPlane_KubeconfigMintChannel drives both routes through the mux, the way the runner calls
// them: every refusal at the console's status code, the spec, the state alias, and the landing.
func TestControlPlane_KubeconfigMintChannel(t *testing.T) {
	key := strings.Repeat("A", 43)
	pending := func(id string) *mintRequestRow {
		return &mintRequestRow{ID: id, ClusterID: "c-1", Tier: "readonly", Shape: "static", TTLSeconds: 900, ClientPublicKey: key, Status: "pending"}
	}
	exec := func(env string) *mintJobGate {
		return &mintJobGate{runnerID: "r-1", jobType: "MINT_KUBECONFIG", status: "PROCESSING", environmentID: env}
	}
	ms := &fakeMintStore{
		jobs: map[string]*mintJobGate{
			"ok": exec("env-a"), "pre-aliased": exec("env-a"), "no-env": exec(""),
			"theirs": {runnerID: "r-2", jobType: "MINT_KUBECONFIG", status: "PROCESSING"},
			"deploy": {runnerID: "r-1", jobType: "DEPLOY", status: "PROCESSING"},
			"done":   {runnerID: "r-1", jobType: "MINT_KUBECONFIG", status: "SUCCESS"},
			"no-row": exec(""), "expired": exec(""), "settled": exec(""),
		},
		rows: map[string]*mintRequestRow{
			"ok": pending("m-ok"), "pre-aliased": pending("m-pre"), "no-env": pending("m-noenv"),
			"theirs": pending("m-x"), "deploy": pending("m-x"), "done": pending("m-x"),
			"expired": {ID: "m-exp", Status: "pending", ExpiredNow: true},
			"settled": {ID: "m-set", Status: "ready"},
		},
		deploys: map[string]string{"env-a": "deploy-a"},
	}
	cp := &ControlPlane{talosStore: &fakeTalosStore{token: sha256Hex("tok")}, mintStore: ms, stateAlias: map[string]string{}}
	cp.AliasStateToJob("pre-aliased", "explicit-slot")
	h := cp.mux()
	do := func(method, job, token, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/jobs/"+job+"/kubeconfig-mint", strings.NewReader(body))
		req.Header.Set("X-Runner-ID", "r-1")
		req.Header.Set("X-Runner-Token", token)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	for job, want := range map[string]int{
		"missing": 404, "theirs": 403, "deploy": 403, "done": 403, "no-row": 404, "expired": 410, "settled": 409,
	} {
		if rec := do(http.MethodGet, job, "tok", ""); rec.Code != want {
			t.Errorf("GET %s = %d %q, want %d", job, rec.Code, rec.Body.String(), want)
		}
	}
	if rec := do(http.MethodGet, "ok", "wrong", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("GET with a wrong token = %d, want 401", rec.Code)
	}

	rec := do(http.MethodGet, "ok", "tok", "")
	var spec types.RunnerKubeconfigMintSpec
	if err := json.Unmarshal(rec.Body.Bytes(), &spec); err != nil || rec.Code != 200 || spec.MintID != "m-ok" || spec.ClusterID != "c-1" || spec.ClientPublicKey != key || spec.TTLSeconds != 900 {
		t.Fatalf("GET ok = %d %q, want the spec of m-ok", rec.Code, rec.Body.String())
	}
	if got := cp.resolveStateKey("ok"); got != "deploy-a" {
		t.Errorf("the spec read aliased the mint's state to %q, want its environment's deploy-a", got)
	}
	do(http.MethodGet, "pre-aliased", "tok", "")
	if got := cp.resolveStateKey("pre-aliased"); got != "explicit-slot" {
		t.Errorf("the spec read overwrote the caller's alias with %q", got)
	}
	do(http.MethodGet, "no-env", "tok", "")
	if got := cp.resolveStateKey("no-env"); got != "no-env" {
		t.Errorf("a mint with no environment was aliased to %q", got)
	}

	ready := func(mintID string) string {
		b, _ := json.Marshal(types.RunnerKubeconfigMintResult{Status: types.KubeconfigMintStatusReady, MintID: mintID, Sealed: "c2VhbGVk", PrivateEndpoint: ptr(false)})
		return string(b)
	}
	if rec := do(http.MethodPost, "ok", "tok", `{"status":"ready","mint_id":"m-ok","sealed":"x"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("a ready result with no private_endpoint = %d, want 400", rec.Code)
	}
	if rec := do(http.MethodPost, "ok", "tok", `not json`); rec.Code != http.StatusBadRequest {
		t.Errorf("a non-JSON result = %d, want 400", rec.Code)
	}
	if rec := do(http.MethodPost, "ok", "tok", ready("m-someone-else")); rec.Code != http.StatusForbidden {
		t.Errorf("a result naming another mint = %d, want 403", rec.Code)
	}
	if rec := do(http.MethodPost, "settled", "tok", ready("m-set")); rec.Code != http.StatusConflict {
		t.Errorf("a second result = %d, want 409", rec.Code)
	}
	if len(ms.landed) != 0 {
		t.Fatalf("a refused post landed %d result(s)", len(ms.landed))
	}
	if rec := do(http.MethodPost, "ok", "tok", ready("m-ok")); rec.Code != http.StatusOK || len(ms.landed) != 1 || ms.landed[0].MintID != "m-ok" {
		t.Fatalf("the result = %d %q (landed %d), want 200 and one landing", rec.Code, rec.Body.String(), len(ms.landed))
	}
	ms.landCode = http.StatusConflict
	if rec := do(http.MethodPost, "ok", "tok", ready("m-ok")); rec.Code != http.StatusConflict || strings.Contains(rec.Body.String(), "c2VhbGVk") {
		t.Errorf("a refused landing = %d %q, want its 409 and no echo of the body", rec.Code, rec.Body.String())
	}
	ms.err = errors.New("db down")
	if rec := do(http.MethodGet, "ok", "tok", ""); rec.Code != http.StatusInternalServerError {
		t.Errorf("an unreadable job = %d, want 500", rec.Code)
	}
}

// flakyKube refuses the first n reads, then admits them — a binding the authorizer has not seen yet.
type flakyKube struct {
	n, calls int
}

// Do answers 403 for the first n calls, then 200 with one node.
func (f *flakyKube) Do(context.Context, string, string, string, []byte) (int, []byte, error) {
	f.calls++
	if f.calls <= f.n {
		return 403, []byte(forbiddenBody), nil
	}
	return 200, []byte(nodeList), nil
}

// TestAwaitFirstRead pins the propagation wait: it returns as soon as the read is admitted, and gives
// up at its bound with the last outcome rather than spinning.
func TestAwaitFirstRead(t *testing.T) {
	k := &flakyKube{n: 2}
	if got := awaitFirstRead(context.Background(), k, "/api/v1/nodes", time.Second, time.Millisecond); got != kubeAllowed || k.calls != 3 {
		t.Errorf("awaitFirstRead = %s after %d calls, want allowed on the third", got, k.calls)
	}
	never := &flakyKube{n: 1 << 30}
	start := time.Now()
	if got := awaitFirstRead(context.Background(), never, "/api/v1/nodes", 30*time.Millisecond, 5*time.Millisecond); got != kubeRefused {
		t.Errorf("a read that is never admitted = %s, want refused at the bound", got)
	}
	if time.Since(start) > 2*time.Second {
		t.Error("awaitFirstRead ignored its bound")
	}
}

// TestTierMintDriver pins who mints each static tier. On cli-demo the CLI holds a SERVICE TOKEN, and
// a service token is refused an admin mint by policy (#5310), so the admin tier must go through the
// runner channel there — the CLI asking for it is a guaranteed 403 that fails the proof after spend.
func TestTierMintDriver(t *testing.T) {
	cases := []struct{ run, tier, want string }{
		{kubeconfigMintDriverCLI, mintTierReadonly, kubeconfigMintDriverCLI},
		{kubeconfigMintDriverCLI, mintTierAdmin, kubeconfigMintDriverRunner},
		{kubeconfigMintDriverRunner, mintTierReadonly, kubeconfigMintDriverRunner},
		{kubeconfigMintDriverRunner, mintTierAdmin, kubeconfigMintDriverRunner},
	}
	for _, c := range cases {
		if got := tierMintDriver(c.run, c.tier); got != c.want {
			t.Errorf("tierMintDriver(%s, %s) = %s, want %s", c.run, c.tier, got, c.want)
		}
	}
	// Every required tier has a driver, and on cli-demo the CLI still mints at least one of them —
	// otherwise the cli driver would prove nothing about the CLI's mint path.
	cliTiers := 0
	for _, tier := range requiredStaticTiers {
		if tierMintDriver(kubeconfigMintDriverCLI, tier) == kubeconfigMintDriverCLI {
			cliTiers++
		}
	}
	if cliTiers == 0 {
		t.Error("under the cli driver no static tier is minted by the CLI")
	}
}

// TestCLIAdminRefusalCheck pins the service-token admin refusal: it passes only when the CLI failed
// AND nothing was produced, and an unreadable row table is an error, never a pass.
func TestCLIAdminRefusalCheck(t *testing.T) {
	exit1 := errors.New("exit status 1")
	cases := []struct {
		name        string
		runErr      error
		row, file   bool
		rowErr      error
		wantPass    bool
		wantOutcome kubeOutcome
	}{
		{"refused, nothing written", exit1, false, false, nil, true, kubeRefused},
		{"cli exited 0", nil, false, false, nil, false, kubeAllowed},
		{"cli failed but a row was written", exit1, true, false, nil, false, kubeAllowed},
		{"cli failed but a kubeconfig was written", exit1, false, true, nil, false, kubeAllowed},
		{"cli failed, rows unreadable", exit1, false, false, errors.New("conn reset"), false, kubeError},
	}
	for _, c := range cases {
		r := cliAdminRefusalCheck(c.runErr, c.row, c.rowErr, c.file)
		if r.Pass != c.wantPass || r.Outcome != string(c.wantOutcome) || r.Name != cliAdminRefusalCheckName || r.Want != string(kubeRefused) {
			t.Errorf("%s: got pass=%t outcome=%s name=%s want=%s; want pass=%t outcome=%s",
				c.name, r.Pass, r.Outcome, r.Name, r.Want, c.wantPass, c.wantOutcome)
		}
	}
}

// TestSummarizeNamesATierMintedByAnotherDriver: a cli-demo summary whose admin tier came through the
// runner channel says so on the verdict line, so the bundle cannot read as a CLI-minted admin.
func TestSummarizeNamesATierMintedByAnotherDriver(t *testing.T) {
	s := passingSummary()
	s.Driver = kubeconfigMintDriverCLI
	s.Tiers[1].Driver = kubeconfigMintDriverRunner
	line := summarizeKubeconfigMint(s)
	if !strings.Contains(line, "admin/static PASS [runner-channel]") {
		t.Errorf("verdict %q does not name the admin tier's driver", line)
	}
	if strings.Contains(line, "readonly/static PASS [") {
		t.Errorf("verdict %q names a driver on a tier the summary's driver minted", line)
	}
	if !summaryPasses(s) {
		t.Error("a per-tier driver changed the verdict")
	}
}
