// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// Alibaba Cloud OpenAPI V3 request signer (signature version ACS3-HMAC-SHA256), hand-rolled over the
// stdlib so packages/core carries NO Alibaba SDK (parity with the "no cloud SDK in the ACK mint lane"
// note in alibaba_namespace_mint.go — the module's only cloud SDK is AWS). It is the signing http.Client
// the Alibaba placement lanes (#1129) feed to ResolveACKClusterConn / the RAM RRSA identity calls.
//
// Keyless: the runner activates a short-lived OIDC assertion for the alicloud tofu provider
// (ActivateAlibabaOIDC sets ALIBABA_CLOUD_ROLE_ARN / _OIDC_PROVIDER_ARN / _OIDC_TOKEN_FILE). This signer
// reuses that ambient env: it bootstraps temporary STS credentials by calling STS AssumeRoleWithOIDC
// ANONYMOUSLY (the OIDC token is the credential — that call carries no Authorization), then V3-signs every
// subsequent ACK/RAM request with the returned temp AccessKeyId/Secret + SecurityToken. No stored key ever
// touches this path. This mirrors how the AWS lane reads ambient keyless creds via LoadDefaultConfig.
//
// The algorithm is implemented to match Alibaba's official signing spec and the reference Go signer
// (alibabacloud-go/openapi-util service.go GetAuthorization); a known-answer test (alibaba_sign_test.go)
// reproduces the doc's published vector. Correctness notes that bit during review:
//   - HMAC key is the RAW AccessKeySecret (no SigV4-style derived signing key).
//   - Signature + both SHA-256 digests are LOWERCASE HEX (never base64).
//   - Only host, content-type and x-acs-* headers are canonicalized/signed; each canonical header line
//     ends "\n"; SignedHeaders is those names sorted, joined with ";".
//   - Empty body → payload hash = SHA-256("") and that same hex is the x-acs-content-sha256 header.
//   - For STS temp creds, x-acs-security-token (and x-acs-accesskey-id) MUST be signed headers.

const (
	// acs3Algorithm is the V3 signature version this signer implements.
	acs3Algorithm = "ACS3-HMAC-SHA256"
	// acs3DateLayout is the x-acs-date format (ISO-8601 UTC, e.g. 2023-10-26T10:22:32Z).
	acs3DateLayout = "2006-01-02T15:04:05Z07:00"
	// emptyPayloadSHA256 is hex(sha256("")) — the x-acs-content-sha256 / payload hash for a body-less
	// request (every ACK GET this lane makes). Precomputed so a GET needs no hashing.
	emptyPayloadSHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	// stsAPIVersion is the STS API version for AssumeRoleWithOIDC.
	stsAPIVersion = "2015-04-01"
	// stsAssumeRoleWithOIDC is the STS action minting temp creds from an OIDC assertion (anonymous).
	stsAssumeRoleWithOIDC = "AssumeRoleWithOIDC"
	// stsCredRefreshSkew re-mints temp creds this long before they actually expire.
	stsCredRefreshSkew = 5 * time.Minute
)

// alibabaTempCredentials is a set of temporary STS credentials from AssumeRoleWithOIDC.
type alibabaTempCredentials struct {
	AccessKeyID     string
	AccessKeySecret string
	SecurityToken   string
	Expiration      time.Time
}

// valid reports whether the credentials are non-empty and not within the refresh skew of expiry.
func (c alibabaTempCredentials) valid(now time.Time) bool {
	return c.AccessKeyID != "" && c.AccessKeySecret != "" &&
		now.Before(c.Expiration.Add(-stsCredRefreshSkew))
}

// alibabaCredentialSource yields temporary STS credentials for signing. Extracted to an interface so the
// signing transport is unit-testable with a static stub (no STS network call).
type alibabaCredentialSource interface {
	credentials(ctx context.Context) (alibabaTempCredentials, error)
}

// oidcEnvCredentialSource bootstraps temp STS creds from the ambient keyless RRSA env the runner sets
// (ALIBABA_CLOUD_ROLE_ARN / _OIDC_PROVIDER_ARN / _OIDC_TOKEN_FILE) via AssumeRoleWithOIDC, caching them
// until the refresh skew. regionID selects the regional STS endpoint.
type oidcEnvCredentialSource struct {
	regionID   string
	httpClient *http.Client

	mu     sync.Mutex
	cached alibabaTempCredentials
}

// credentials returns cached temp creds, re-minting via AssumeRoleWithOIDC when empty or near expiry.
func (s *oidcEnvCredentialSource) credentials(ctx context.Context) (alibabaTempCredentials, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cached.valid(time.Now()) {
		return s.cached, nil
	}
	creds, err := s.assumeRoleWithOIDC(ctx)
	if err != nil {
		return alibabaTempCredentials{}, err
	}
	s.cached = creds
	return creds, nil
}

// stsAssumeRoleWithOIDCResponse is the JSON shape of a successful AssumeRoleWithOIDC call.
type stsAssumeRoleWithOIDCResponse struct {
	Credentials struct {
		AccessKeyID     string `json:"AccessKeyId"`
		AccessKeySecret string `json:"AccessKeySecret"`
		SecurityToken   string `json:"SecurityToken"`
		Expiration      string `json:"Expiration"`
	} `json:"Credentials"`
	Code    string `json:"Code"`
	Message string `json:"Message"`
}

// assumeRoleWithOIDC performs the ANONYMOUS V3 STS call that exchanges the pod's OIDC assertion for
// temporary credentials. Anonymous means it carries the x-acs-* metadata headers but NO Authorization —
// the OIDC token is the credential (the chicken-and-egg breaker: the first creds are minted with no AK).
func (s *oidcEnvCredentialSource) assumeRoleWithOIDC(ctx context.Context) (alibabaTempCredentials, error) {
	roleArn := os.Getenv("ALIBABA_CLOUD_ROLE_ARN")
	providerArn := os.Getenv("ALIBABA_CLOUD_OIDC_PROVIDER_ARN")
	tokenFile := os.Getenv("ALIBABA_CLOUD_OIDC_TOKEN_FILE")
	sessionName := os.Getenv("ALIBABA_CLOUD_ROLE_SESSION_NAME")
	if sessionName == "" {
		sessionName = "alethia-runner"
	}
	if roleArn == "" || providerArn == "" || tokenFile == "" {
		return alibabaTempCredentials{}, fmt.Errorf("alibaba signer: keyless RRSA env not set (need ALIBABA_CLOUD_ROLE_ARN, ALIBABA_CLOUD_OIDC_PROVIDER_ARN, ALIBABA_CLOUD_OIDC_TOKEN_FILE) — the runner must ActivateAlibabaOIDC before an output-free ACK resolve")
	}
	oidcToken, err := os.ReadFile(tokenFile)
	if err != nil {
		return alibabaTempCredentials{}, fmt.Errorf("alibaba signer: read OIDC token file %q: %w", tokenFile, err)
	}
	if strings.TrimSpace(string(oidcToken)) == "" {
		return alibabaTempCredentials{}, fmt.Errorf("alibaba signer: OIDC token file %q is empty", tokenFile)
	}

	// V3 RPC AssumeRoleWithOIDC: business params in the form body; Action/Version/date/nonce in headers.
	host := fmt.Sprintf("sts.%s.aliyuncs.com", s.regionID)
	form := url.Values{}
	form.Set("RoleArn", roleArn)
	form.Set("OIDCProviderArn", providerArn)
	form.Set("OIDCToken", strings.TrimSpace(string(oidcToken)))
	form.Set("RoleSessionName", sessionName)
	body := form.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+host+"/", strings.NewReader(body))
	if err != nil {
		return alibabaTempCredentials{}, err
	}
	req.Header.Set("host", host)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	req.Header.Set("x-acs-action", stsAssumeRoleWithOIDC)
	req.Header.Set("x-acs-version", stsAPIVersion)
	req.Header.Set("x-acs-date", time.Now().UTC().Format(acs3DateLayout))
	req.Header.Set("x-acs-signature-nonce", acs3Nonce())
	req.Header.Set("x-acs-content-sha256", hexSHA256([]byte(body)))
	// NO Authorization header — AssumeRoleWithOIDC allows anonymous access.

	client := s.httpClient
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return alibabaTempCredentials{}, fmt.Errorf("alibaba AssumeRoleWithOIDC: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return alibabaTempCredentials{}, fmt.Errorf("alibaba AssumeRoleWithOIDC: status %d: %s", resp.StatusCode, ackErrSnippet(respBody))
	}
	var parsed stsAssumeRoleWithOIDCResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return alibabaTempCredentials{}, fmt.Errorf("alibaba AssumeRoleWithOIDC: decode: %w", err)
	}
	if parsed.Credentials.AccessKeyID == "" || parsed.Credentials.AccessKeySecret == "" {
		return alibabaTempCredentials{}, fmt.Errorf("alibaba AssumeRoleWithOIDC: response carried no credentials (code %q: %s)", parsed.Code, parsed.Message)
	}
	exp, err := time.Parse(time.RFC3339, parsed.Credentials.Expiration)
	if err != nil {
		// A missing/odd expiry shouldn't wedge the deploy — treat it as short-lived.
		exp = time.Now().Add(time.Hour)
	}
	return alibabaTempCredentials{
		AccessKeyID:     parsed.Credentials.AccessKeyID,
		AccessKeySecret: parsed.Credentials.AccessKeySecret,
		SecurityToken:   parsed.Credentials.SecurityToken,
		Expiration:      exp,
	}, nil
}

// alibabaSigningTransport wraps a base RoundTripper and V3-signs every request with temp STS creds. The
// CALLER sets x-acs-action + x-acs-version on the request (they identify the operation and vary per call);
// the transport adds host, x-acs-date, x-acs-signature-nonce, x-acs-content-sha256, the STS token headers
// and the Authorization line, then canonicalizes+signs.
type alibabaSigningTransport struct {
	source alibabaCredentialSource
	base   http.RoundTripper
}

// RoundTrip signs and forwards req. A clone is signed (never the caller's request), so retries re-sign.
func (t *alibabaSigningTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	creds, err := t.source.credentials(req.Context())
	if err != nil {
		return nil, err
	}

	signed := req.Clone(req.Context())

	// Payload hash. Every ACK GET this lane makes is body-less; hash a body if one is present.
	payloadHash := emptyPayloadSHA256
	if signed.Body != nil && signed.Body != http.NoBody {
		raw, rerr := io.ReadAll(signed.Body)
		if rerr != nil {
			return nil, fmt.Errorf("alibaba signer: read body: %w", rerr)
		}
		signed.Body = io.NopCloser(strings.NewReader(string(raw)))
		signed.ContentLength = int64(len(raw))
		payloadHash = hexSHA256(raw)
	}

	if signed.Header.Get("host") == "" {
		signed.Header.Set("host", signed.URL.Host)
	}
	signed.Header.Set("x-acs-date", time.Now().UTC().Format(acs3DateLayout))
	signed.Header.Set("x-acs-signature-nonce", acs3Nonce())
	signed.Header.Set("x-acs-content-sha256", payloadHash)
	// STS temp-cred headers — both MUST be signed (they are x-acs-*, so canonicalization folds them in).
	signed.Header.Set("x-acs-accesskey-id", creds.AccessKeyID)
	if creds.SecurityToken != "" {
		signed.Header.Set("x-acs-security-token", creds.SecurityToken)
	}

	auth := signACS3(signParams{
		method:       signed.Method,
		canonicalURI: acs3EncodePath(signed.URL.EscapedPath()),
		query:        signed.URL.Query(),
		headers:      signed.Header,
		payloadHash:  payloadHash,
		accessKeyID:  creds.AccessKeyID,
		secret:       creds.AccessKeySecret,
	})
	signed.Header.Set("Authorization", auth)

	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	return base.RoundTrip(signed)
}

// signParams is the fully-resolved input to the pure ACS3 signature (the unit-testable core — the
// known-answer test feeds it the doc's published vector directly).
type signParams struct {
	method       string
	canonicalURI string
	query        url.Values
	headers      http.Header
	payloadHash  string
	accessKeyID  string
	secret       string
}

// signACS3 builds the Authorization header per the ACS3-HMAC-SHA256 spec. Pure: given identical inputs it
// yields an identical signature (the header set must already carry x-acs-date / -signature-nonce /
// -content-sha256 and, for STS, the token headers).
func signACS3(p signParams) string {
	canonicalHeaders, signedHeaders := acs3CanonicalHeaders(p.headers)
	canonicalRequest := strings.Join([]string{
		p.method,
		p.canonicalURI,
		acs3CanonicalQueryString(p.query),
		canonicalHeaders,
		signedHeaders,
		p.payloadHash,
	}, "\n")
	stringToSign := acs3Algorithm + "\n" + hexSHA256([]byte(canonicalRequest))
	signature := hex.EncodeToString(hmacSHA256([]byte(p.secret), stringToSign))
	return acs3Algorithm + " Credential=" + p.accessKeyID +
		",SignedHeaders=" + signedHeaders +
		",Signature=" + signature
}

// acs3CanonicalHeaders returns the canonical-headers block (each "name:value\n", names lowercased +
// trimmed + ascending-sorted) and the SignedHeaders list (";"-joined). Only host, content-type and
// x-acs-* headers participate.
func acs3CanonicalHeaders(h http.Header) (canonical, signed string) {
	type kv struct{ name, value string }
	var entries []kv
	for name, values := range h {
		lower := strings.ToLower(name)
		if lower != "host" && lower != "content-type" && !strings.HasPrefix(lower, "x-acs-") {
			continue
		}
		trimmed := make([]string, 0, len(values))
		for _, v := range values {
			trimmed = append(trimmed, strings.TrimSpace(v))
		}
		entries = append(entries, kv{name: lower, value: strings.Join(trimmed, ",")})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].name < entries[j].name })

	var cb strings.Builder
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		cb.WriteString(e.name)
		cb.WriteString(":")
		cb.WriteString(e.value)
		cb.WriteString("\n")
		names = append(names, e.name)
	}
	return cb.String(), strings.Join(names, ";")
}

// acs3CanonicalQueryString sorts params by name ascending and joins "key=value" (value RFC3986-encoded,
// empty value → trailing "="). Matches the reference getCanonicalQueryString (encode value, then normalize
// +→%20, *→%2A, %7E→~).
func acs3CanonicalQueryString(q url.Values) string {
	if len(q) == 0 {
		return ""
	}
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		v := ""
		if len(q[k]) > 0 {
			v = q[k][0]
		}
		if v == "" {
			parts = append(parts, acs3Escape(k)+"=")
		} else {
			parts = append(parts, acs3Escape(k)+"="+acs3Escape(v))
		}
	}
	return strings.Join(parts, "&")
}

// acs3EncodePath single-encodes each path segment (RFC3986) while preserving "/" separators — the ROA
// CanonicalURI rule (reference GetEncodePath). For the ACK paths this lane uses (hex cluster ids, fixed
// segments) nothing actually gets encoded, but this keeps the canonicalization exact.
func acs3EncodePath(path string) string {
	if path == "" {
		return "/"
	}
	segments := strings.Split(path, "/")
	for i, seg := range segments {
		segments[i] = acs3Escape(seg)
	}
	return strings.Join(segments, "/")
}

// acs3Escape applies RFC3986 percent-encoding matching the reference signer: url.QueryEscape, then
// +→%20 (space), *→%2A, %7E→~ so the unreserved set A-Za-z0-9-_.~ is never encoded.
func acs3Escape(s string) string {
	e := url.QueryEscape(s)
	e = strings.ReplaceAll(e, "+", "%20")
	e = strings.ReplaceAll(e, "*", "%2A")
	e = strings.ReplaceAll(e, "%7E", "~")
	return e
}

// hexSHA256 returns the lowercase-hex SHA-256 of b.
func hexSHA256(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// hmacSHA256 returns HMAC-SHA256(key, msg) as raw bytes (the caller hex-encodes).
func hmacSHA256(key []byte, msg string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(msg))
	return h.Sum(nil)
}

// acs3Nonce returns a unique per-request nonce (32 hex chars from crypto/rand).
func acs3Nonce() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failure is effectively impossible; fall back to a time-derived nonce so a signed
		// request is still produced (uniqueness is for replay-protection, best-effort on this rare path).
		return hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(b[:])
}

// newAlibabaSigningClient builds an http.Client whose transport V3-signs every request with temporary STS
// creds bootstrapped keylessly (AssumeRoleWithOIDC) from the ambient RRSA env. regionID selects the
// regional STS + service endpoints. The returned client is fed to ResolveACKClusterConn / the RAM RRSA
// calls, which set x-acs-action + x-acs-version and construct the URL/body.
func newAlibabaSigningClient(ctx context.Context, regionID string) (*http.Client, error) {
	if strings.TrimSpace(regionID) == "" {
		return nil, fmt.Errorf("alibaba signer: region id is required")
	}
	source := &oidcEnvCredentialSource{regionID: regionID}
	// Fail fast + populate the cache: surface a missing-env / bad-OIDC error here rather than on the first
	// opaque ACK 403.
	if _, err := source.credentials(ctx); err != nil {
		return nil, err
	}
	return &http.Client{
		Timeout:   30 * time.Second,
		Transport: &alibabaSigningTransport{source: source},
	}, nil
}
