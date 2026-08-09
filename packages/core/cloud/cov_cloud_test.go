// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// covRoundTripper answers every request from a func — the seam every http.Client-injecting
// cloud lane in this package already exposes, so no test here opens a socket.
type covRoundTripper struct {
	fn func(*http.Request) (*http.Response, error)
}

func (rt covRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) { return rt.fn(req) }

// covClient wraps fn in an http.Client.
func covClient(fn func(*http.Request) (*http.Response, error)) *http.Client {
	return &http.Client{Transport: covRoundTripper{fn: fn}}
}

// covResponse builds a canned HTTP response.
func covResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}

// covCancelledCtx returns an already-cancelled context. A client.Do with it fails inside the
// transport without ever dialling — the deterministic way to exercise a "client == nil"
// default-client branch without reaching the real cloud endpoint.
func covCancelledCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return ctx
}

// covIsolateHome points HOME (and TMPDIR, the fallback) at scratch dirs and neutralises
// KUBECONFIG, so the kubeconfig writers — which os.Setenv KUBECONFIG — leave no trace.
func covIsolateHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("TMPDIR", t.TempDir())
	t.Setenv("KUBECONFIG", "")
	return home
}

// ---------------------------------------------------------------------------
// alibaba_sign.go — the hand-rolled ACS3 signer + its keyless STS bootstrap
// ---------------------------------------------------------------------------

// covStaticCreds is a stub alibabaCredentialSource: no STS call.
type covStaticCreds struct {
	creds alibabaTempCredentials
	err   error
}

func (s covStaticCreds) credentials(context.Context) (alibabaTempCredentials, error) {
	return s.creds, s.err
}

// covRRSAEnv points the ambient keyless RRSA env at a real token file in a scratch dir.
func covRRSAEnv(t *testing.T, token string) {
	t.Helper()
	f := filepath.Join(t.TempDir(), "oidc-token")
	if err := os.WriteFile(f, []byte(token), 0600); err != nil {
		t.Fatalf("write token file: %v", err)
	}
	t.Setenv("ALIBABA_CLOUD_ROLE_ARN", "acs:ram::123456789012:role/alethia-runner")
	t.Setenv("ALIBABA_CLOUD_OIDC_PROVIDER_ARN", "acs:ram::123456789012:oidc-provider/ack-rrsa-c1")
	t.Setenv("ALIBABA_CLOUD_OIDC_TOKEN_FILE", f)
	t.Setenv("ALIBABA_CLOUD_ROLE_SESSION_NAME", "")
}

// TestCloud_AlibabaTempCredentials_ValidHonoursTheRefreshSkew pins that credentials are
// treated as unusable once they are within the re-mint skew of expiry — a credential that
// expires mid-apply is worse than one re-minted early.
func TestCloud_AlibabaTempCredentials_ValidHonoursTheRefreshSkew(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	full := alibabaTempCredentials{AccessKeyID: "ak", AccessKeySecret: "sk", Expiration: now.Add(time.Hour)}
	if !full.valid(now) {
		t.Fatal("a fresh credential must be valid")
	}
	if full.valid(now.Add(time.Hour - stsCredRefreshSkew)) {
		t.Fatal("a credential inside the refresh skew must be treated as invalid")
	}
	if (alibabaTempCredentials{AccessKeySecret: "sk", Expiration: now.Add(time.Hour)}).valid(now) {
		t.Fatal("a credential with no access key id must be invalid")
	}
	if (alibabaTempCredentials{AccessKeyID: "ak", Expiration: now.Add(time.Hour)}).valid(now) {
		t.Fatal("a credential with no secret must be invalid")
	}
}

// TestCloud_AlibabaCredentials_ReusesTheCachedCredential pins that a still-valid cached
// credential is returned without a second AssumeRoleWithOIDC round-trip.
func TestCloud_AlibabaCredentials_ReusesTheCachedCredential(t *testing.T) {
	src := &oidcEnvCredentialSource{
		regionID: "cn-hangzhou",
		cached: alibabaTempCredentials{
			AccessKeyID: "ak", AccessKeySecret: "sk", Expiration: time.Now().Add(2 * time.Hour),
		},
		httpClient: covClient(func(*http.Request) (*http.Response, error) {
			t.Error("a cached credential must not trigger an STS call")
			return covResponse(500, ""), nil
		}),
	}
	got, err := src.credentials(context.Background())
	if err != nil || got.AccessKeyID != "ak" {
		t.Fatalf("credentials: %+v %v", got, err)
	}
}

// TestCloud_AlibabaAssumeRoleWithOIDC_MintsAndCachesTempCredentials pins the keyless
// bootstrap: the anonymous STS call carries the OIDC assertion and NO Authorization header,
// and the minted credentials are cached on the source.
func TestCloud_AlibabaAssumeRoleWithOIDC_MintsAndCachesTempCredentials(t *testing.T) {
	covRRSAEnv(t, "  header.payload.sig  ")
	var seen *http.Request
	var body string
	src := &oidcEnvCredentialSource{
		regionID: "cn-hangzhou",
		httpClient: covClient(func(req *http.Request) (*http.Response, error) {
			seen = req
			raw, _ := io.ReadAll(req.Body)
			body = string(raw)
			return covResponse(200, `{"Credentials":{"AccessKeyId":"STS.ak","AccessKeySecret":"sk","SecurityToken":"tok","Expiration":"2099-01-01T00:00:00Z"}}`), nil
		}),
	}
	got, err := src.credentials(context.Background())
	if err != nil {
		t.Fatalf("credentials: %v", err)
	}
	if got.AccessKeyID != "STS.ak" || got.AccessKeySecret != "sk" || got.SecurityToken != "tok" {
		t.Fatalf("unexpected credentials: %+v", got)
	}
	if src.cached.AccessKeyID != "STS.ak" {
		t.Fatal("minted credentials must be cached on the source")
	}
	if seen.Header.Get("Authorization") != "" {
		t.Fatal("AssumeRoleWithOIDC must be anonymous — no Authorization header")
	}
	if seen.URL.Host != "sts.cn-hangzhou.aliyuncs.com" {
		t.Fatalf("wrong regional STS endpoint: %s", seen.URL.Host)
	}
	if seen.Header.Get("x-acs-action") != stsAssumeRoleWithOIDC || seen.Header.Get("x-acs-version") != stsAPIVersion {
		t.Fatalf("missing action/version headers: %v", seen.Header)
	}
	form, err := url.ParseQuery(body)
	if err != nil {
		t.Fatalf("parse form: %v", err)
	}
	if form.Get("OIDCToken") != "header.payload.sig" {
		t.Fatalf("the OIDC assertion must be trimmed and sent verbatim, got %q", form.Get("OIDCToken"))
	}
	if form.Get("RoleSessionName") != "alethia-runner" {
		t.Fatalf("default session name: %q", form.Get("RoleSessionName"))
	}
}

// TestCloud_AlibabaAssumeRoleWithOIDC_UnparseableExpiryIsTreatedAsShortLived pins that a
// missing/odd Expiration does not wedge the deploy — the credential is kept, dated an hour out.
func TestCloud_AlibabaAssumeRoleWithOIDC_UnparseableExpiryIsTreatedAsShortLived(t *testing.T) {
	covRRSAEnv(t, "tok")
	src := &oidcEnvCredentialSource{
		regionID: "cn-hangzhou",
		httpClient: covClient(func(*http.Request) (*http.Response, error) {
			return covResponse(200, `{"Credentials":{"AccessKeyId":"ak","AccessKeySecret":"sk"}}`), nil
		}),
	}
	got, err := src.credentials(context.Background())
	if err != nil {
		t.Fatalf("credentials: %v", err)
	}
	if got.Expiration.Before(time.Now().Add(30 * time.Minute)) {
		t.Fatalf("an unparseable expiry must fall back to a short-lived window, got %v", got.Expiration)
	}
}

// TestCloud_AlibabaAssumeRoleWithOIDC_FailsClosed pins every refusal on the keyless bootstrap:
// missing RRSA env, an unreadable or empty assertion, a transport failure, a non-2xx, an
// undecodable body, and a 200 that carried no credentials.
func TestCloud_AlibabaAssumeRoleWithOIDC_FailsClosed(t *testing.T) {
	okBody := func(*http.Request) (*http.Response, error) {
		return covResponse(200, `{"Credentials":{"AccessKeyId":"ak","AccessKeySecret":"sk"}}`), nil
	}

	t.Run("no rrsa env", func(t *testing.T) {
		t.Setenv("ALIBABA_CLOUD_ROLE_ARN", "")
		t.Setenv("ALIBABA_CLOUD_OIDC_PROVIDER_ARN", "")
		t.Setenv("ALIBABA_CLOUD_OIDC_TOKEN_FILE", "")
		src := &oidcEnvCredentialSource{regionID: "cn-hangzhou", httpClient: covClient(okBody)}
		if _, err := src.credentials(context.Background()); err == nil ||
			!strings.Contains(err.Error(), "keyless RRSA env not set") {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("token file missing", func(t *testing.T) {
		covRRSAEnv(t, "tok")
		t.Setenv("ALIBABA_CLOUD_OIDC_TOKEN_FILE", filepath.Join(t.TempDir(), "absent"))
		src := &oidcEnvCredentialSource{regionID: "cn-hangzhou", httpClient: covClient(okBody)}
		if _, err := src.credentials(context.Background()); err == nil ||
			!strings.Contains(err.Error(), "read OIDC token file") {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("token file empty", func(t *testing.T) {
		covRRSAEnv(t, "   \n")
		src := &oidcEnvCredentialSource{regionID: "cn-hangzhou", httpClient: covClient(okBody)}
		if _, err := src.credentials(context.Background()); err == nil ||
			!strings.Contains(err.Error(), "is empty") {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("transport failure", func(t *testing.T) {
		covRRSAEnv(t, "tok")
		src := &oidcEnvCredentialSource{regionID: "cn-hangzhou", httpClient: covClient(func(*http.Request) (*http.Response, error) {
			return nil, io.ErrUnexpectedEOF
		})}
		if _, err := src.credentials(context.Background()); err == nil ||
			!strings.Contains(err.Error(), "alibaba AssumeRoleWithOIDC") {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("non 2xx", func(t *testing.T) {
		covRRSAEnv(t, "tok")
		src := &oidcEnvCredentialSource{regionID: "cn-hangzhou", httpClient: covClient(func(*http.Request) (*http.Response, error) {
			return covResponse(403, `{"Code":"NoPermission"}`), nil
		})}
		if _, err := src.credentials(context.Background()); err == nil ||
			!strings.Contains(err.Error(), "status 403") {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("undecodable body", func(t *testing.T) {
		covRRSAEnv(t, "tok")
		src := &oidcEnvCredentialSource{regionID: "cn-hangzhou", httpClient: covClient(func(*http.Request) (*http.Response, error) {
			return covResponse(200, `not json`), nil
		})}
		if _, err := src.credentials(context.Background()); err == nil ||
			!strings.Contains(err.Error(), "decode") {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("no credentials in body", func(t *testing.T) {
		covRRSAEnv(t, "tok")
		src := &oidcEnvCredentialSource{regionID: "cn-hangzhou", httpClient: covClient(func(*http.Request) (*http.Response, error) {
			return covResponse(200, `{"Code":"Throttled","Message":"slow down"}`), nil
		})}
		if _, err := src.credentials(context.Background()); err == nil ||
			!strings.Contains(err.Error(), "carried no credentials") {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

// TestCloud_AlibabaSigningTransport_SignsAClone pins the V3 signing contract on every
// forwarded request: the caller's request is never mutated, the STS token headers are set and
// signed, and a body is hashed into x-acs-content-sha256.
func TestCloud_AlibabaSigningTransport_SignsAClone(t *testing.T) {
	var seen *http.Request
	tr := &alibabaSigningTransport{
		source: covStaticCreds{creds: alibabaTempCredentials{AccessKeyID: "ak", AccessKeySecret: "sk", SecurityToken: "tok"}},
		base: covRoundTripper{fn: func(req *http.Request) (*http.Response, error) {
			seen = req
			return covResponse(200, "{}"), nil
		}},
	}
	req, err := http.NewRequest(http.MethodPost, "https://cs.cn-hangzhou.aliyuncs.com/clusters?a=1&b=", strings.NewReader("payload"))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("x-acs-action", "DescribeClusters")
	resp, err := tr.RoundTrip(req)
	if err != nil {
		t.Fatalf("RoundTrip: %v", err)
	}
	resp.Body.Close()

	if req.Header.Get("Authorization") != "" {
		t.Fatal("the caller's request must not be mutated — a clone is signed")
	}
	auth := seen.Header.Get("Authorization")
	if !strings.HasPrefix(auth, acs3Algorithm+" Credential=ak,") {
		t.Fatalf("unexpected Authorization: %q", auth)
	}
	for _, want := range []string{"x-acs-accesskey-id", "x-acs-security-token", "x-acs-content-sha256"} {
		if !strings.Contains(auth, want) {
			t.Fatalf("%q must be a signed header: %q", want, auth)
		}
	}
	if seen.Header.Get("x-acs-content-sha256") != hexSHA256([]byte("payload")) {
		t.Fatal("the body must be hashed into x-acs-content-sha256")
	}
	if seen.Header.Get("host") != "cs.cn-hangzhou.aliyuncs.com" {
		t.Fatalf("host header: %q", seen.Header.Get("host"))
	}
	body, _ := io.ReadAll(seen.Body)
	if string(body) != "payload" {
		t.Fatalf("the body must be replayable after hashing, got %q", body)
	}
}

// TestCloud_AlibabaSigningTransport_CredentialFailureAborts pins that an unusable credential
// source stops the request rather than sending an unsigned one.
func TestCloud_AlibabaSigningTransport_CredentialFailureAborts(t *testing.T) {
	tr := &alibabaSigningTransport{source: covStaticCreds{err: io.ErrUnexpectedEOF}}
	req, err := http.NewRequest(http.MethodGet, "https://cs.cn-hangzhou.aliyuncs.com/clusters", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if _, err := tr.RoundTrip(req); err == nil {
		t.Fatal("expected the credential failure to abort the request")
	}
}

// TestCloud_AlibabaSigningTransport_DefaultsToTheStdlibTransport pins that a transport with no
// explicit base still forwards (through http.DefaultTransport). The request is aimed at a
// closed local port so it fails immediately without leaving the machine.
func TestCloud_AlibabaSigningTransport_DefaultsToTheStdlibTransport(t *testing.T) {
	tr := &alibabaSigningTransport{
		source: covStaticCreds{creds: alibabaTempCredentials{AccessKeyID: "ak", AccessKeySecret: "sk"}},
	}
	req, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:1/clusters", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if _, err := tr.RoundTrip(req); err == nil {
		t.Fatal("expected a connection failure against a closed port")
	}
}

// TestCloud_ACS3Canonicalization_OnlySignsTheSpecifiedHeaders pins that only host,
// content-type and x-acs-* participate in the canonical header block — signing an
// Authorization or User-Agent header would make every retry a different signature.
func TestCloud_ACS3Canonicalization_OnlySignsTheSpecifiedHeaders(t *testing.T) {
	h := http.Header{}
	h.Set("Host", "example.com")
	h.Set("Content-Type", "application/json")
	h.Set("X-Acs-Action", "DescribeClusters")
	h.Set("User-Agent", "alethia")
	h.Set("Authorization", "ignored")
	canonical, signed := acs3CanonicalHeaders(h)
	if signed != "content-type;host;x-acs-action" {
		t.Fatalf("unexpected SignedHeaders: %q", signed)
	}
	if strings.Contains(canonical, "user-agent") || strings.Contains(canonical, "authorization") {
		t.Fatalf("unsigned headers leaked into the canonical block: %q", canonical)
	}
}

// TestCloud_ACS3EncodingHelpers_HandleTheDegenerateInputs pins the empty-query and empty-path
// canonicalization rules (an empty path canonicalizes to "/", an empty query to "").
func TestCloud_ACS3EncodingHelpers_HandleTheDegenerateInputs(t *testing.T) {
	if got := acs3CanonicalQueryString(url.Values{}); got != "" {
		t.Fatalf("empty query: %q", got)
	}
	if got := acs3CanonicalQueryString(nil); got != "" {
		t.Fatalf("nil query: %q", got)
	}
	if got := acs3EncodePath(""); got != "/" {
		t.Fatalf("empty path: %q", got)
	}
	if got := acs3EncodePath("/clusters/c 1"); got != "/clusters/c%201" {
		t.Fatalf("path encoding: %q", got)
	}
}

// TestCloud_NewAlibabaSigningClient_FailsClosed pins that the signing client refuses to build
// without a region, and surfaces the keyless-bootstrap failure rather than an opaque later 403.
func TestCloud_NewAlibabaSigningClient_FailsClosed(t *testing.T) {
	if _, err := newAlibabaSigningClient(context.Background(), "  "); err == nil ||
		!strings.Contains(err.Error(), "region id is required") {
		t.Fatalf("unexpected error: %v", err)
	}
	t.Setenv("ALIBABA_CLOUD_ROLE_ARN", "")
	t.Setenv("ALIBABA_CLOUD_OIDC_PROVIDER_ARN", "")
	t.Setenv("ALIBABA_CLOUD_OIDC_TOKEN_FILE", "")
	if _, err := newAlibabaSigningClient(context.Background(), "cn-hangzhou"); err == nil ||
		!strings.Contains(err.Error(), "keyless RRSA env not set") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ---------------------------------------------------------------------------
// alibaba_tenant_identity.go — the per-namespace RAM role lane
// ---------------------------------------------------------------------------

// TestCloud_EnsureACKNamespaceRole_AlreadyExistsIsSuccess pins the idempotent create: a RAM
// EntityAlreadyExists.Role is success (the trust is deterministic), anything else is fatal.
func TestCloud_EnsureACKNamespaceRole_AlreadyExistsIsSuccess(t *testing.T) {
	created := covClient(func(req *http.Request) (*http.Response, error) {
		if req.Header.Get("x-acs-action") != "CreateRole" {
			t.Errorf("unexpected action %q", req.Header.Get("x-acs-action"))
		}
		return covResponse(200, `{"Role":{"Arn":"acs:ram::1:role/r","RoleName":"r"}}`), nil
	})
	if err := ensureACKNamespaceRole(context.Background(), created, "r", "{}"); err != nil {
		t.Fatalf("create: %v", err)
	}

	exists := covClient(func(*http.Request) (*http.Response, error) {
		return covResponse(409, `{"Code":"EntityAlreadyExists.Role"}`), nil
	})
	if err := ensureACKNamespaceRole(context.Background(), exists, "r", "{}"); err != nil {
		t.Fatalf("an existing role must be success: %v", err)
	}

	denied := covClient(func(*http.Request) (*http.Response, error) {
		return covResponse(403, `{"Code":"NoPermission"}`), nil
	})
	if err := ensureACKNamespaceRole(context.Background(), denied, "r", "{}"); err == nil ||
		!strings.Contains(err.Error(), `create per-namespace RAM role "r"`) {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestCloud_RAMRPC_ReportsTheRAMCode pins that a non-2xx RAM answer is wrapped in a *ramError
// carrying the RAM Code — that code is what the idempotent-create path classifies on.
func TestCloud_RAMRPC_ReportsTheRAMCode(t *testing.T) {
	client := covClient(func(req *http.Request) (*http.Response, error) {
		if req.Header.Get("x-acs-version") != ramAPIVersion {
			t.Errorf("missing RAM api version: %v", req.Header)
		}
		if !strings.HasPrefix(req.URL.String(), ramAPIHost) {
			t.Errorf("unexpected RAM host: %s", req.URL)
		}
		return covResponse(400, `{"Code":"EntityAlreadyExists.Role"}`), nil
	})
	_, err := ramRPC(context.Background(), client, "CreateRole", url.Values{"RoleName": {"r"}})
	if err == nil {
		t.Fatal("expected a ramError")
	}
	if !isRAMAlreadyExists(err) {
		t.Fatalf("EntityAlreadyExists.Role must be classified as already-exists: %v", err)
	}
	if !strings.Contains(err.Error(), `ram CreateRole: status 400 (code "EntityAlreadyExists.Role")`) {
		t.Fatalf("unexpected ramError text: %v", err)
	}
	if isRAMAlreadyExists(io.ErrUnexpectedEOF) {
		t.Fatal("a non-RAM error must not be classified as already-exists")
	}

	ok := covClient(func(*http.Request) (*http.Response, error) {
		return covResponse(200, `{"Role":{"Arn":"acs:ram::1:role/r","RoleName":"r"}}`), nil
	})
	got, err := ramRPC(context.Background(), ok, "GetRole", url.Values{})
	if err != nil {
		t.Fatalf("ramRPC: %v", err)
	}
	if got.Role.RoleName != "r" {
		t.Fatalf("unexpected role: %+v", got.Role)
	}
}

// TestCloud_RAMRPC_TransportFailureIsWrapped pins that a RAM call made with the default client
// still names the action when the request cannot be delivered.
func TestCloud_RAMRPC_TransportFailureIsWrapped(t *testing.T) {
	if _, err := ramRPC(covCancelledCtx(t), nil, "CreateRole", url.Values{}); err == nil ||
		!strings.Contains(err.Error(), "ram CreateRole") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestCloud_ProvisionACKNamespaceIdentity_FailsClosedWithoutTheKeylessSession pins that the
// entrypoint refuses before it touches RAM when the keyless RRSA env is absent.
func TestCloud_ProvisionACKNamespaceIdentity_FailsClosedWithoutTheKeylessSession(t *testing.T) {
	t.Setenv("ALIBABA_CLOUD_ROLE_ARN", "")
	t.Setenv("ALIBABA_CLOUD_OIDC_PROVIDER_ARN", "")
	t.Setenv("ALIBABA_CLOUD_OIDC_TOKEN_FILE", "")
	if _, err := ProvisionACKNamespaceIdentity(context.Background(), "cn-hangzhou", "c", "ns"); err == nil ||
		!strings.Contains(err.Error(), "build keyless signing client") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestCloud_ACKNamespaceTrust_IsScopedToTheNamespace pins the derived trust document: it
// federates only to the cluster's RRSA provider, only for `<ns>:*`, only for sts.aliyuncs.com.
func TestCloud_ACKNamespaceTrust_IsScopedToTheNamespace(t *testing.T) {
	trust, err := buildACKNamespaceTrustPolicy("acs:ram::1:oidc-provider/ack-rrsa-c1", "team-ns")
	if err != nil {
		t.Fatalf("buildACKNamespaceTrustPolicy: %v", err)
	}
	var doc ackTrustDoc
	if err := json.Unmarshal([]byte(trust), &doc); err != nil {
		t.Fatalf("trust is not valid JSON: %v", err)
	}
	st := doc.Statement[0]
	if st.Condition["StringLike"]["oidc:sub"] != "system:serviceaccount:team-ns:*" {
		t.Fatalf("unexpected sub condition: %v", st.Condition)
	}
	if st.Condition["StringEquals"]["oidc:aud"] != ackRRSAAudience {
		t.Fatalf("unexpected aud condition: %v", st.Condition)
	}
	if _, err := buildACKNamespaceTrustPolicy("", "ns"); err == nil {
		t.Fatal("a trust policy without a provider ARN must be refused")
	}
	if _, err := buildACKNamespaceTrustPolicy("arn", ""); err == nil {
		t.Fatal("a trust policy without a namespace must be refused")
	}
}

// ---------------------------------------------------------------------------
// gcp_namespace_identity.go — per-namespace Workload-Identity GSA
// ---------------------------------------------------------------------------

// TestCloud_ProvisionGKENamespaceIdentity_RejectsIncompleteInput pins the fail-closed guards:
// no keyless token, or a missing project/cluster/namespace, provisions nothing.
func TestCloud_ProvisionGKENamespaceIdentity_RejectsIncompleteInput(t *testing.T) {
	deny := covClient(func(*http.Request) (*http.Response, error) {
		t.Error("no IAM call may be made for an invalid input")
		return covResponse(500, ""), nil
	})
	if _, err := ProvisionGKENamespaceIdentity(context.Background(), deny, "  ", "p", "c", "ns"); err == nil ||
		!strings.Contains(err.Error(), "empty access token") {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, args := range [][3]string{{"", "c", "ns"}, {"p", "", "ns"}, {"p", "c", ""}} {
		if _, err := ProvisionGKENamespaceIdentity(context.Background(), deny, "tok", args[0], args[1], args[2]); err == nil ||
			!strings.Contains(err.Error(), "must all be set") {
			t.Fatalf("%v: unexpected error %v", args, err)
		}
	}
}

// TestCloud_ProvisionGKENamespaceIdentity_CreatesAndBindsAdditively pins the happy path: the
// zero-perm GSA is created and the workloadIdentityUser member is merged into the existing
// policy without clobbering the other bindings.
func TestCloud_ProvisionGKENamespaceIdentity_CreatesAndBindsAdditively(t *testing.T) {
	var setBody []byte
	client := covClient(func(req *http.Request) (*http.Response, error) {
		switch {
		case strings.HasSuffix(req.URL.Path, "/serviceAccounts"):
			if req.Header.Get("Authorization") != "Bearer tok" {
				t.Errorf("bearer not set: %v", req.Header)
			}
			return covResponse(200, `{}`), nil
		case strings.HasSuffix(req.URL.Path, ":getIamPolicy"):
			return covResponse(200, `{"etag":"e1","bindings":[{"role":"roles/other","members":["user:a@b.c"]}]}`), nil
		case strings.HasSuffix(req.URL.Path, ":setIamPolicy"):
			setBody, _ = io.ReadAll(req.Body)
			return covResponse(200, `{}`), nil
		}
		t.Errorf("unexpected IAM call %s", req.URL)
		return covResponse(500, ""), nil
	})
	email, err := ProvisionGKENamespaceIdentity(context.Background(), client, "tok", "proj-1", "cluster-a", "team-ns")
	if err != nil {
		t.Fatalf("ProvisionGKENamespaceIdentity: %v", err)
	}
	want := gkeNamespaceGSAEmail("proj-1", namespaceGSAAccountID("cluster-a", "team-ns"))
	if email != want {
		t.Fatalf("want %q, got %q", want, email)
	}
	if !IsValidGSAEmail(email) {
		t.Fatalf("the derived email must be shell-safe: %q", email)
	}
	body := string(setBody)
	if !strings.Contains(body, gkeWorkloadIdentityUserRole) ||
		!strings.Contains(body, gkeWorkloadIdentityMember("proj-1", "team-ns")) {
		t.Fatalf("the WI binding was not added: %s", body)
	}
	if !strings.Contains(body, "roles/other") {
		t.Fatalf("pre-existing bindings must be preserved: %s", body)
	}
}

// TestCloud_ProvisionGKENamespaceIdentity_AlreadyBoundIsANoop pins idempotence: a GSA that
// already carries the member (409 on create, member present in the policy) issues no setIamPolicy.
func TestCloud_ProvisionGKENamespaceIdentity_AlreadyBoundIsANoop(t *testing.T) {
	member := gkeWorkloadIdentityMember("proj-1", "team-ns")
	client := covClient(func(req *http.Request) (*http.Response, error) {
		switch {
		case strings.HasSuffix(req.URL.Path, "/serviceAccounts"):
			return covResponse(409, `{}`), nil
		case strings.HasSuffix(req.URL.Path, ":getIamPolicy"):
			return covResponse(200, `{"bindings":[{"role":"`+gkeWorkloadIdentityUserRole+`","members":["`+member+`"]}]}`), nil
		}
		t.Errorf("an already-bound identity must not be re-written (%s)", req.URL)
		return covResponse(500, ""), nil
	})
	if _, err := ProvisionGKENamespaceIdentity(context.Background(), client, "tok", "proj-1", "cluster-a", "team-ns"); err != nil {
		t.Fatalf("ProvisionGKENamespaceIdentity: %v", err)
	}
}

// TestCloud_ProvisionGKENamespaceIdentity_SurfacesEveryIAMFailure pins that a failed create,
// getIamPolicy, policy decode or setIamPolicy each abort with their own message — a partly
// provisioned identity must never be reported as ready.
func TestCloud_ProvisionGKENamespaceIdentity_SurfacesEveryIAMFailure(t *testing.T) {
	cases := []struct {
		name string
		fn   func(*http.Request) (*http.Response, error)
		want string
	}{
		{"create denied", func(req *http.Request) (*http.Response, error) {
			return covResponse(403, `{}`), nil
		}, "create service account"},
		{"getIamPolicy denied", func(req *http.Request) (*http.Response, error) {
			if strings.HasSuffix(req.URL.Path, "/serviceAccounts") {
				return covResponse(200, `{}`), nil
			}
			return covResponse(403, `{}`), nil
		}, "getIamPolicy"},
		{"policy undecodable", func(req *http.Request) (*http.Response, error) {
			if strings.HasSuffix(req.URL.Path, "/serviceAccounts") {
				return covResponse(200, `{}`), nil
			}
			return covResponse(200, `not json`), nil
		}, "decode iam policy"},
		{"setIamPolicy denied", func(req *http.Request) (*http.Response, error) {
			switch {
			case strings.HasSuffix(req.URL.Path, "/serviceAccounts"):
				return covResponse(200, `{}`), nil
			case strings.HasSuffix(req.URL.Path, ":getIamPolicy"):
				return covResponse(200, `{}`), nil
			}
			return covResponse(409, `{}`), nil
		}, "setIamPolicy"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ProvisionGKENamespaceIdentity(context.Background(), covClient(tc.fn), "tok", "proj-1", "cluster-a", "team-ns")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %q, got %v", tc.want, err)
			}
		})
	}
}

// TestCloud_ProvisionGKENamespaceIdentity_DefaultClientTransportErrorIsWrapped pins that the
// nil-client default is used and a transport failure is attributed to the IAM lane.
func TestCloud_ProvisionGKENamespaceIdentity_DefaultClientTransportErrorIsWrapped(t *testing.T) {
	ctx := covCancelledCtx(t)
	if _, err := ProvisionGKENamespaceIdentity(ctx, nil, "tok", "proj-1", "cluster-a", "team-ns"); err == nil ||
		!strings.Contains(err.Error(), "gke namespace identity") {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := DeprovisionGKENamespaceIdentity(ctx, nil, "tok", "proj-1", "cluster-a", "team-ns"); err == nil ||
		!strings.Contains(err.Error(), "gke namespace identity") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestCloud_DeprovisionGKENamespaceIdentity_MissingGSAIsSuccess pins teardown: 200 and 404 are
// both success, any other status is an error.
func TestCloud_DeprovisionGKENamespaceIdentity_MissingGSAIsSuccess(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusNotFound} {
		client := covClient(func(req *http.Request) (*http.Response, error) {
			if req.Method != http.MethodDelete {
				t.Errorf("teardown must DELETE, got %s", req.Method)
			}
			return covResponse(status, `{}`), nil
		})
		if err := DeprovisionGKENamespaceIdentity(context.Background(), client, "tok", "p", "c", "ns"); err != nil {
			t.Fatalf("status %d: %v", status, err)
		}
	}
	denied := covClient(func(*http.Request) (*http.Response, error) { return covResponse(403, `{}`), nil })
	if err := DeprovisionGKENamespaceIdentity(context.Background(), denied, "tok", "p", "c", "ns"); err == nil ||
		!strings.Contains(err.Error(), "delete service account") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestCloud_IAMSafeURL_DropsTheQuery pins that an IAM URL is trimmed at "?" before it reaches
// an error message.
func TestCloud_IAMSafeURL_DropsTheQuery(t *testing.T) {
	if got := iamSafeURL("https://iam.googleapis.com/v1/x?alt=json"); got != "https://iam.googleapis.com/v1/x" {
		t.Fatalf("got %q", got)
	}
	if got := iamSafeURL("https://iam.googleapis.com/v1/x"); got != "https://iam.googleapis.com/v1/x" {
		t.Fatalf("got %q", got)
	}
}

// ---------------------------------------------------------------------------
// gcp_namespace_mint.go
// ---------------------------------------------------------------------------

// TestCloud_ResolveGKEClusterConn_FailureModes pins the request-construction and decode
// failures on the GKE clusters.get lane, and that an over-long error body is bounded.
func TestCloud_ResolveGKEClusterConn_FailureModes(t *testing.T) {
	// The nil-client default path, exercised without dialling.
	if _, err := ResolveGKEClusterConn(covCancelledCtx(t), nil, "tok", "p", "l", "c"); err == nil ||
		!strings.Contains(err.Error(), "gke clusters.get") {
		t.Fatalf("unexpected error: %v", err)
	}

	if _, err := ResolveGKEClusterConn(context.Background(), covClient(func(*http.Request) (*http.Response, error) {
		return covResponse(200, "not json"), nil
	}), "tok", "p", "l", "c"); err == nil || !strings.Contains(err.Error(), "decode") {
		t.Fatalf("unexpected error: %v", err)
	}

	long := strings.Repeat("x", 400)
	_, err := ResolveGKEClusterConn(context.Background(), covClient(func(*http.Request) (*http.Response, error) {
		return covResponse(500, long), nil
	}), "tok", "p", "l", "c")
	if err == nil || !strings.Contains(err.Error(), "…") {
		t.Fatalf("an over-long error body must be bounded, got %v", err)
	}
	if len(err.Error()) > 400 {
		t.Fatalf("error message was not bounded: %d chars", len(err.Error()))
	}
}

// ---------------------------------------------------------------------------
// azure_namespace_identity.go — per-namespace UAMI + federated credential
// ---------------------------------------------------------------------------

// TestCloud_NamespaceUAMIName_BoundsALongNamespace pins that a long namespace is clipped
// (the ARM name has a 128-char ceiling) while staying deterministic through the hash suffix.
func TestCloud_NamespaceUAMIName_BoundsALongNamespace(t *testing.T) {
	long := strings.Repeat("n", 80)
	got := namespaceUAMIName("cluster-a", long)
	if len(got) != len("alethia-ns-")+32+1+8 {
		t.Fatalf("unexpected length %d: %q", len(got), got)
	}
	if got != namespaceUAMIName("cluster-a", long) {
		t.Fatal("the derivation must be deterministic")
	}
	if got == namespaceUAMIName("cluster-b", long) {
		t.Fatal("two clusters must not collide on one name")
	}
}

// TestCloud_ProvisionAKSNamespaceIdentity_SurfacesEveryARMFailure pins the fail-closed guards
// and each ARM failure on the UAMI + federated-credential upserts.
func TestCloud_ProvisionAKSNamespaceIdentity_SurfacesEveryARMFailure(t *testing.T) {
	const clientID = "0f8fad5b-d9cb-469f-a165-70867728950e"
	uamiOK := `{"properties":{"clientId":"` + clientID + `"}}`

	if _, err := ProvisionAKSNamespaceIdentity(context.Background(), nil, " ", "s", "rg", "westeurope", "https://iss", "c", "ns"); err == nil ||
		!strings.Contains(err.Error(), "empty ARM token") {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := ProvisionAKSNamespaceIdentity(context.Background(), nil, "tok", "", "rg", "westeurope", "https://iss", "c", "ns"); err == nil ||
		!strings.Contains(err.Error(), "must be set") {
		t.Fatalf("unexpected error: %v", err)
	}

	cases := []struct {
		name string
		fn   func(*http.Request) (*http.Response, error)
		want string
	}{
		{"uami put denied", func(*http.Request) (*http.Response, error) {
			return covResponse(403, `{"error":{"code":"AuthorizationFailed"}}`), nil
		}, "create user-assigned identity"},
		{"uami body undecodable", func(*http.Request) (*http.Response, error) {
			return covResponse(200, `not json`), nil
		}, "decode identity response"},
		{"uami without clientId", func(*http.Request) (*http.Response, error) {
			return covResponse(200, `{"properties":{}}`), nil
		}, "returned no/invalid clientId"},
		{"federated credential denied", func(req *http.Request) (*http.Response, error) {
			if strings.Contains(req.URL.Path, "/federatedIdentityCredentials/") {
				return covResponse(403, `{"error":{"code":"AuthorizationFailed"}}`), nil
			}
			return covResponse(200, uamiOK), nil
		}, "create federated credential"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ProvisionAKSNamespaceIdentity(context.Background(), covClient(tc.fn),
				"tok", "sub", "rg", "westeurope", "https://iss", "c", "ns")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %q, got %v", tc.want, err)
			}
		})
	}
}

// TestCloud_ProvisionAKSNamespaceIdentity_UpsertsBothResources pins the happy path: the
// zero-perm UAMI is upserted and the federated credential trusts exactly the namespace's
// default ServiceAccount on the cluster's OIDC issuer.
func TestCloud_ProvisionAKSNamespaceIdentity_UpsertsBothResources(t *testing.T) {
	const clientID = "0f8fad5b-d9cb-469f-a165-70867728950e"
	var ficBody string
	client := covClient(func(req *http.Request) (*http.Response, error) {
		if req.Method != http.MethodPut {
			t.Errorf("both resources must be upserted with PUT, got %s", req.Method)
		}
		if strings.Contains(req.URL.Path, "/federatedIdentityCredentials/") {
			raw, _ := io.ReadAll(req.Body)
			ficBody = string(raw)
			return covResponse(200, `{}`), nil
		}
		return covResponse(200, `{"properties":{"clientId":"`+clientID+`"}}`), nil
	})
	got, err := ProvisionAKSNamespaceIdentity(context.Background(), client,
		"tok", "sub", "rg", "westeurope", "https://oidc.example", "cluster-a", "team-ns")
	if err != nil {
		t.Fatalf("ProvisionAKSNamespaceIdentity: %v", err)
	}
	if got != clientID {
		t.Fatalf("want %q, got %q", clientID, got)
	}
	if !strings.Contains(ficBody, `"subject":"system:serviceaccount:team-ns:default"`) {
		t.Fatalf("the federated credential must trust only the namespace default KSA: %s", ficBody)
	}
	if !strings.Contains(ficBody, `"issuer":"https://oidc.example"`) {
		t.Fatalf("the federated credential must name the cluster issuer: %s", ficBody)
	}
}

// TestCloud_DeprovisionAKSNamespaceIdentity_DeletesTheIdentity pins teardown: the UAMI is
// DELETEd (which removes its federated credentials), and an ARM failure is reported.
func TestCloud_DeprovisionAKSNamespaceIdentity_DeletesTheIdentity(t *testing.T) {
	var seen *http.Request
	ok := covClient(func(req *http.Request) (*http.Response, error) {
		seen = req
		return covResponse(204, ``), nil
	})
	if err := DeprovisionAKSNamespaceIdentity(context.Background(), ok, "tok", "sub", "rg", "cluster-a", "team-ns"); err != nil {
		t.Fatalf("DeprovisionAKSNamespaceIdentity: %v", err)
	}
	if seen.Method != http.MethodDelete ||
		!strings.Contains(seen.URL.Path, namespaceUAMIName("cluster-a", "team-ns")) {
		t.Fatalf("unexpected teardown call: %s %s", seen.Method, seen.URL)
	}

	denied := covClient(func(*http.Request) (*http.Response, error) {
		return covResponse(403, `{"error":{"code":"AuthorizationFailed"}}`), nil
	})
	if err := DeprovisionAKSNamespaceIdentity(context.Background(), denied, "tok", "sub", "rg", "c", "ns"); err == nil ||
		!strings.Contains(err.Error(), "delete user-assigned identity") {
		t.Fatalf("unexpected error: %v", err)
	}

	// The nil-client default, exercised without dialling.
	if err := DeprovisionAKSNamespaceIdentity(covCancelledCtx(t), nil, "tok", "sub", "rg", "c", "ns"); err == nil {
		t.Fatal("expected the cancelled context to abort teardown")
	}
}

// ---------------------------------------------------------------------------
// kubeconfig.go — the shared per-worker kubeconfig writers
// ---------------------------------------------------------------------------

// TestCloud_WriteRawKubeconfig_WritesToAPrivateHomePath pins that a ready-made kubeconfig
// lands 0600 under $HOME/.alethia and KUBECONFIG is pointed at it.
func TestCloud_WriteRawKubeconfig_WritesToAPrivateHomePath(t *testing.T) {
	home := covIsolateHome(t)
	var out strings.Builder
	if err := writeRawKubeconfig("apiVersion: v1\n", &out); err != nil {
		t.Fatalf("writeRawKubeconfig: %v", err)
	}
	path := filepath.Join(home, ".alethia", "kubeconfig")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("kubeconfig must be 0600, got %v", info.Mode().Perm())
	}
	if os.Getenv("KUBECONFIG") != path {
		t.Fatalf("KUBECONFIG points at %q", os.Getenv("KUBECONFIG"))
	}
	if !strings.Contains(out.String(), path) {
		t.Fatalf("the destination must be reported: %q", out.String())
	}
	if err := writeRawKubeconfig("   ", &out); err == nil {
		t.Fatal("an empty kubeconfig must be refused")
	}
}

// TestCloud_WriteRawKubeconfig_FallsBackToTempWhenHomeIsUnset pins that a worker with no HOME
// still gets a private kubeconfig path rather than a cwd-relative one.
func TestCloud_WriteRawKubeconfig_FallsBackToTempWhenHomeIsUnset(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", "")
	t.Setenv("TMPDIR", tmp)
	t.Setenv("KUBECONFIG", "")
	var out strings.Builder
	if err := writeRawKubeconfig("apiVersion: v1\n", &out); err != nil {
		t.Fatalf("writeRawKubeconfig: %v", err)
	}
	if _, err := os.Stat(filepath.Join(os.TempDir(), ".alethia", "kubeconfig")); err != nil {
		t.Fatalf("expected the temp-dir fallback: %v", err)
	}
}

// TestCloud_KubeconfigWriters_ReportFilesystemFailures pins that an unusable HOME (a file, or a
// directory where the kubeconfig belongs) is an error, not a silently skipped write.
func TestCloud_KubeconfigWriters_ReportFilesystemFailures(t *testing.T) {
	var out strings.Builder
	execArgs := []string{"kube-token", "--cloud", "aws"}

	t.Run("home is a file", func(t *testing.T) {
		dir := t.TempDir()
		file := filepath.Join(dir, "home-file")
		if err := os.WriteFile(file, []byte("x"), 0600); err != nil {
			t.Fatalf("write: %v", err)
		}
		t.Setenv("HOME", file)
		t.Setenv("KUBECONFIG", "")
		if err := writeRawKubeconfig("apiVersion: v1\n", &out); err == nil {
			t.Fatal("expected the mkdir to fail")
		}
		if err := writeExecKubeconfig("c", "https://api", "Y2E=", execArgs, &out); err == nil {
			t.Fatal("expected the mkdir to fail")
		}
	})

	t.Run("kubeconfig path is a directory", func(t *testing.T) {
		home := t.TempDir()
		if err := os.MkdirAll(filepath.Join(home, ".alethia", "kubeconfig"), 0700); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		t.Setenv("HOME", home)
		t.Setenv("KUBECONFIG", "")
		if err := writeRawKubeconfig("apiVersion: v1\n", &out); err == nil {
			t.Fatal("expected the write to fail")
		}
		if err := writeExecKubeconfig("c", "https://api", "Y2E=", execArgs, &out); err == nil {
			t.Fatal("expected the write to fail")
		}
	})
}

// TestCloud_WriteExecKubeconfig_RequiresEndpointAndCA pins that an exec-plugin kubeconfig is
// never written half-formed — without a server or a CA it would silently trust anything.
func TestCloud_WriteExecKubeconfig_RequiresEndpointAndCA(t *testing.T) {
	covIsolateHome(t)
	var out strings.Builder
	if err := writeExecKubeconfig("c", "", "Y2E=", nil, &out); err == nil ||
		!strings.Contains(err.Error(), "no cluster endpoint") {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := writeExecKubeconfig("c", "https://api", "", nil, &out); err == nil ||
		!strings.Contains(err.Error(), "no cluster CA certificate") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestCloud_WriteExecKubeconfig_UsesTheRunnerBinaryAsTheCredentialPlugin pins that the
// exec-plugin `command` is the running binary's ABSOLUTE path — a bare name would be resolved
// through PATH from the writable job workdir.
func TestCloud_WriteExecKubeconfig_UsesTheRunnerBinaryAsTheCredentialPlugin(t *testing.T) {
	home := covIsolateHome(t)
	var out strings.Builder
	if err := writeExecKubeconfig("cluster-a", "https://api.example", "Y2E=", []string{"kube-token", "--cloud", "aws"}, &out); err != nil {
		t.Fatalf("writeExecKubeconfig: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(home, ".alethia", "kubeconfig"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	self := runnerBinaryPath()
	if !filepath.IsAbs(self) {
		t.Fatalf("the credential-plugin command must be absolute, got %q", self)
	}
	for _, want := range []string{"https://api.example", "Y2E=", self, "kube-token"} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("kubeconfig missing %q:\n%s", want, data)
		}
	}
}

// ---------------------------------------------------------------------------
// hetzner_provider.go — the Talos lane
// ---------------------------------------------------------------------------

// TestCloud_HetznerProvider_NeedsNoCLIs pins that the Talos lane declares no CLI dependency —
// the terraform provider does machine-config, bootstrap and kubeconfig retrieval in-apply.
func TestCloud_HetznerProvider_NeedsNoCLIs(t *testing.T) {
	p := &hetznerProvider{}
	if p.Name() != "hetzner" {
		t.Fatalf("name: %q", p.Name())
	}
	if got := p.RequiredCLIs(); len(got) != 0 {
		t.Fatalf("hetzner must need no CLI, got %v", got)
	}
}

// TestCloud_CidrSubnet_RefusesUnusableInputs pins that cidrSubnet returns "" (so the caller
// falls back to a safe literal) rather than an out-of-range or IPv6 answer.
func TestCloud_CidrSubnet_RefusesUnusableInputs(t *testing.T) {
	cases := []struct {
		base    string
		newBits int
		netNum  int
	}{
		{"not-a-cidr", 1, 0},
		{"fd00::/8", 1, 0},
		{"10.0.0.0/16", 17, 0},
		{"10.0.0.0/16", -20, 0},
		{"10.0.0.0/16", 1, 2},
		{"10.0.0.0/16", 1, -1},
	}
	for _, tc := range cases {
		if got := cidrSubnet(tc.base, tc.newBits, tc.netNum); got != "" {
			t.Fatalf("cidrSubnet(%q, %d, %d) = %q, want \"\"", tc.base, tc.newBits, tc.netNum, got)
		}
	}
	if got := cidrSubnet("10.0.0.0/16", 1, 1); got != "10.0.128.0/17" {
		t.Fatalf("cidrSubnet: %q", got)
	}
}

// TestCloud_HetznerServerArch_MapsAmpereToArm64 pins the Talos image architecture rule: only
// the CAX (Ampere) series is arm64. Getting this wrong churned ~100 VMs in prod once.
func TestCloud_HetznerServerArch_MapsAmpereToArm64(t *testing.T) {
	for _, arm := range []string{"cax11", "CAX21", "cax41"} {
		if got := hetznerServerArch(arm); got != "arm64" {
			t.Fatalf("%s: %q", arm, got)
		}
	}
	for _, amd := range []string{"cpx22", "cx22", "ccx13", ""} {
		if got := hetznerServerArch(amd); got != "amd64" {
			t.Fatalf("%s: %q", amd, got)
		}
	}
}

// TestCloud_HetznerProviderTfvars_WorkerCountFollowsTheSizingLadder pins the node-count
// resolution: desired wins, then min, then a single worker.
func TestCloud_HetznerProviderTfvars_WorkerCountFollowsTheSizingLadder(t *testing.T) {
	cases := []struct {
		name     string
		desired  int
		min      int
		expected int
	}{
		{"desired wins", 4, 2, 4},
		{"min when no desired", 0, 3, 3},
		{"default", 0, 0, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := &types.ProjectConfig{}
			cfg.Cluster.NodeDesiredSize = tc.desired
			cfg.Cluster.NodeMinSize = tc.min
			tfvars := (&hetznerProvider{}).ProviderTfvars(cfg)
			if tfvars["worker_count"] != tc.expected {
				t.Fatalf("worker_count = %v, want %d", tfvars["worker_count"], tc.expected)
			}
		})
	}
}

// TestCloud_HetznerProviderTfvars_CarriesTheAmbientTokens pins that the hcloud API token and
// the (separate) Object-Storage keys reach the template from the runner env — the in-cluster
// CCM/CSI and the minio provider have no other source.
func TestCloud_HetznerProviderTfvars_CarriesTheAmbientTokens(t *testing.T) {
	t.Setenv("HCLOUD_TOKEN", "hc-token")
	t.Setenv("HETZNER_S3_ACCESS_KEY", "ak")
	t.Setenv("HETZNER_S3_SECRET_KEY", "sk")
	cfg := &types.ProjectConfig{}
	tfvars := (&hetznerProvider{}).ProviderTfvars(cfg)
	if tfvars["hcloud_token"] != "hc-token" {
		t.Fatalf("hcloud_token = %v", tfvars["hcloud_token"])
	}
	if tfvars["hetzner_s3_access_key"] != "ak" || tfvars["hetzner_s3_secret_key"] != "sk" {
		t.Fatalf("s3 keys not carried: %v / %v", tfvars["hetzner_s3_access_key"], tfvars["hetzner_s3_secret_key"])
	}

	t.Setenv("HCLOUD_TOKEN", "")
	t.Setenv("HETZNER_S3_ACCESS_KEY", "")
	t.Setenv("HETZNER_S3_SECRET_KEY", "")
	tfvars = (&hetznerProvider{}).ProviderTfvars(cfg)
	for _, k := range []string{"hcloud_token", "hetzner_s3_access_key", "hetzner_s3_secret_key"} {
		if _, ok := tfvars[k]; ok {
			t.Fatalf("%s must be absent when the env var is unset", k)
		}
	}
}

// TestCloud_HetznerConfigureKubeconfig_WritesTheTalosOutput pins that the Talos run's
// `kubeconfig` output is written verbatim to the per-worker path, and that a run without one
// fails rather than leaving a stale kubeconfig in place.
func TestCloud_HetznerConfigureKubeconfig_WritesTheTalosOutput(t *testing.T) {
	home := covIsolateHome(t)
	p := &hetznerProvider{}
	var out strings.Builder
	outputs := map[string]interface{}{
		"kubeconfig":   map[string]interface{}{"value": "apiVersion: v1\nkind: Config\n"},
		"cluster_name": map[string]interface{}{"value": "talos-a"},
	}
	if err := p.ConfigureKubeconfig(context.Background(), &types.ProjectConfig{}, outputs, &out); err != nil {
		t.Fatalf("ConfigureKubeconfig: %v", err)
	}
	path := filepath.Join(home, ".alethia", "kubeconfig")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(data) != "apiVersion: v1\nkind: Config\n" {
		t.Fatalf("kubeconfig was not written verbatim: %q", data)
	}
	if os.Getenv("KUBECONFIG") != path {
		t.Fatalf("KUBECONFIG points at %q", os.Getenv("KUBECONFIG"))
	}

	if err := p.ConfigureKubeconfig(context.Background(), &types.ProjectConfig{}, map[string]interface{}{}, &out); err == nil ||
		!strings.Contains(err.Error(), "no kubeconfig in Talos outputs") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestCloud_HetznerConfigureKubeconfig_ReportsFilesystemFailures pins that an unusable HOME
// aborts the kubeconfig write instead of reporting a cluster that cannot be reached.
func TestCloud_HetznerConfigureKubeconfig_ReportsFilesystemFailures(t *testing.T) {
	p := &hetznerProvider{}
	var out strings.Builder
	outputs := map[string]interface{}{"kubeconfig": "apiVersion: v1\n"}

	dir := t.TempDir()
	file := filepath.Join(dir, "home-file")
	if err := os.WriteFile(file, []byte("x"), 0600); err != nil {
		t.Fatalf("write: %v", err)
	}
	t.Setenv("HOME", file)
	t.Setenv("KUBECONFIG", "")
	if err := p.ConfigureKubeconfig(context.Background(), &types.ProjectConfig{}, outputs, &out); err == nil {
		t.Fatal("expected the mkdir to fail")
	}

	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".alethia", "kubeconfig"), 0700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	t.Setenv("HOME", home)
	if err := p.ConfigureKubeconfig(context.Background(), &types.ProjectConfig{}, outputs, &out); err == nil {
		t.Fatal("expected the write to fail")
	}
}

// TestCloud_HetznerConfigureKubeconfig_FallsBackToTempWhenHomeIsUnset pins the no-HOME
// fallback on the Talos lane.
func TestCloud_HetznerConfigureKubeconfig_FallsBackToTempWhenHomeIsUnset(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", "")
	t.Setenv("TMPDIR", tmp)
	t.Setenv("KUBECONFIG", "")
	var out strings.Builder
	outputs := map[string]interface{}{"kubeconfig": "apiVersion: v1\n"}
	if err := (&hetznerProvider{}).ConfigureKubeconfig(context.Background(), &types.ProjectConfig{}, outputs, &out); err != nil {
		t.Fatalf("ConfigureKubeconfig: %v", err)
	}
	if _, err := os.Stat(filepath.Join(os.TempDir(), ".alethia", "kubeconfig")); err != nil {
		t.Fatalf("expected the temp-dir fallback: %v", err)
	}
}

// TestCloud_OutputString_ToleratesBothOutputShapes pins that a tofu output is read whether it
// arrives wrapped (`{"value": …}`) or bare, and that anything else reads as empty.
func TestCloud_OutputString_ToleratesBothOutputShapes(t *testing.T) {
	cases := map[string]struct {
		outputs map[string]interface{}
		want    string
	}{
		"wrapped":            {map[string]interface{}{"k": map[string]interface{}{"value": "v"}}, "v"},
		"bare":               {map[string]interface{}{"k": "v"}, "v"},
		"absent":             {map[string]interface{}{}, ""},
		"wrapped non-string": {map[string]interface{}{"k": map[string]interface{}{"value": 7}}, ""},
		"non-string":         {map[string]interface{}{"k": 7}, ""},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := outputString(tc.outputs, "k"); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// TestCloud_ProviderString_ReadsOnlyStrings pins that a provider_config lookup returns "" for
// an absent key, a nil map, or a non-string value — never a panic or a coerced value.
func TestCloud_ProviderString_ReadsOnlyStrings(t *testing.T) {
	if got := providerString(nil, "k"); got != "" {
		t.Fatalf("nil map: %q", got)
	}
	if got := providerString(map[string]any{"k": 7}, "k"); got != "" {
		t.Fatalf("non-string: %q", got)
	}
	if got := providerString(map[string]any{"k": "v"}, "k"); got != "v" {
		t.Fatalf("string: %q", got)
	}
}

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

// TestCloud_Clip_StaysCollisionSafeAtADegenerateCap pins that clip never returns the same
// output for two different inputs, even when the cap is shorter than the hash suffix it
// would normally append.
func TestCloud_Clip_StaysCollisionSafeAtADegenerateCap(t *testing.T) {
	a := strings.Repeat("a", 40)
	b := strings.Repeat("a", 39) + "b"
	if clip(a, 4) == clip(b, 4) {
		t.Fatal("a degenerate cap must still separate two distinct inputs")
	}
	if got := clip(a, 4); len(got) != 4 {
		t.Fatalf("clip must honour the cap, got %q", got)
	}
	if got := clip("short", 40); got != "short" {
		t.Fatalf("an under-cap value must pass through, got %q", got)
	}
}

// TestCloud_ResolveK8sVersion_FallsBackToTheCatalog pins that an explicit version wins, that
// the catalog supplies the per-provider default, and that a provider the catalog does not
// know yields "" rather than a made-up version.
func TestCloud_ResolveK8sVersion_FallsBackToTheCatalog(t *testing.T) {
	if got := resolveK8sVersion("aws", "1.31"); got != "1.31" {
		t.Fatalf("explicit version: %q", got)
	}
	if got := resolveK8sVersion("no-such-cloud", ""); got != "" {
		t.Fatalf("an unknown provider must have no default, got %q", got)
	}
	if got := resolveK8sVersion("aws", ""); got == "" {
		t.Fatal("aws must have a catalog default")
	}
}

// TestCloud_WriteBackendHCL_ReportsAnUnwritableDirectory pins that a backend.hcl which cannot
// be written is an error — `tofu init` would otherwise run against the wrong state.
func TestCloud_WriteBackendHCL_ReportsAnUnwritableDirectory(t *testing.T) {
	c := &HTTPBackendConfig{}
	if _, err := c.WriteBackendHCL(filepath.Join(t.TempDir(), "absent")); err == nil ||
		!strings.Contains(err.Error(), "failed to write backend.hcl") {
		t.Fatalf("unexpected error: %v", err)
	}
}
