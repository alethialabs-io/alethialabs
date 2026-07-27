// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"net/http"
	"net/url"
	"testing"
	"time"
)

// TestSignACS3_KnownAnswer reproduces the worked example published in Alibaba's official V3
// request-structure-and-signature doc, end to end (CanonicalRequest → StringToSign → HMAC). Because the
// AccessKeyId/Secret are the doc's placeholders, matching the expected Authorization verbatim proves the
// canonicalization AND the HMAC are byte-exact — a wrong-but-plausible signer would diverge here.
//
// Vector (doc): RunInstances, ECS 2014-05-26, nonce 3156853299f313e23d1673dc12e1703d,
// date 2023-10-26T10:22:32Z → Signature 06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0.
func TestSignACS3_KnownAnswer(t *testing.T) {
	h := http.Header{}
	h.Set("host", "ecs.cn-shanghai.aliyuncs.com")
	h.Set("x-acs-action", "RunInstances")
	h.Set("x-acs-content-sha256", emptyPayloadSHA256)
	h.Set("x-acs-date", "2023-10-26T10:22:32Z")
	h.Set("x-acs-signature-nonce", "3156853299f313e23d1673dc12e1703d")
	h.Set("x-acs-version", "2014-05-26")

	q := url.Values{}
	q.Set("ImageId", "win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd")
	q.Set("RegionId", "cn-shanghai")

	got := signACS3(signParams{
		method:       http.MethodPost,
		canonicalURI: "/",
		query:        q,
		headers:      h,
		payloadHash:  emptyPayloadSHA256,
		accessKeyID:  "YourAccessKeyId",
		secret:       "YourAccessKeySecret",
	})

	want := "ACS3-HMAC-SHA256 Credential=YourAccessKeyId," +
		"SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version," +
		"Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0"
	if got != want {
		t.Fatalf("ACS3 authorization mismatch:\n got: %s\nwant: %s", got, want)
	}
}

// TestACS3CanonicalQueryString covers the encoding rules that bite: ascending sort, empty value → "key=",
// and RFC3986 escaping of a reserved char in the value.
func TestACS3CanonicalQueryString(t *testing.T) {
	q := url.Values{}
	q.Set("b", "")
	q.Set("a", "x y") // space → %20 (not +)
	q.Set("c", "cn-hangzhou")
	got := acs3CanonicalQueryString(q)
	want := "a=x%20y&b=&c=cn-hangzhou"
	if got != want {
		t.Fatalf("canonical query mismatch:\n got: %s\nwant: %s", got, want)
	}
}

// TestACS3EncodePath preserves slashes and leaves ACK-style segments untouched.
func TestACS3EncodePath(t *testing.T) {
	got := acs3EncodePath("/k8s/c3fb96524f9274b4495df0f12a6b5abc/user_config")
	want := "/k8s/c3fb96524f9274b4495df0f12a6b5abc/user_config"
	if got != want {
		t.Fatalf("encoded path mismatch:\n got: %s\nwant: %s", got, want)
	}
}

// staticCredSource is a test alibabaCredentialSource returning fixed temp creds (no STS call).
type staticCredSource struct{ creds alibabaTempCredentials }

func (s staticCredSource) credentials(context.Context) (alibabaTempCredentials, error) {
	return s.creds, nil
}

// TestSigningTransport_AddsSignedHeaders asserts the transport stamps the mandatory x-acs-* headers, folds
// the STS SecurityToken in as a signed header, and emits an Authorization line — without mutating the
// caller's original request.
func TestSigningTransport_AddsSignedHeaders(t *testing.T) {
	var captured *http.Request
	tr := &alibabaSigningTransport{
		source: staticCredSource{creds: alibabaTempCredentials{
			AccessKeyID:     "STS.Ak",
			AccessKeySecret: "sec",
			SecurityToken:   "tok",
			Expiration:      time.Now().Add(time.Hour),
		}},
		base: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			captured = r
			return &http.Response{StatusCode: 200, Body: http.NoBody, Header: http.Header{}}, nil
		}),
	}

	orig, _ := http.NewRequestWithContext(context.Background(), http.MethodGet,
		"https://cs.cn-hangzhou.aliyuncs.com/k8s/c123/user_config?PrivateIpAddress=false", nil)
	orig.Header.Set("x-acs-action", "DescribeClusterUserKubeconfig")
	orig.Header.Set("x-acs-version", "2015-12-15")

	if _, err := tr.RoundTrip(orig); err != nil {
		t.Fatalf("RoundTrip: %v", err)
	}
	if orig.Header.Get("Authorization") != "" {
		t.Fatal("original request must not be mutated with Authorization")
	}
	for _, hname := range []string{"Authorization", "x-acs-date", "x-acs-signature-nonce", "x-acs-content-sha256", "x-acs-security-token", "x-acs-accesskey-id"} {
		if captured.Header.Get(hname) == "" {
			t.Errorf("signed request missing header %q", hname)
		}
	}
	if captured.Header.Get("x-acs-content-sha256") != emptyPayloadSHA256 {
		t.Errorf("GET payload hash = %q, want empty-body hash", captured.Header.Get("x-acs-content-sha256"))
	}
}

// roundTripFunc adapts a func to http.RoundTripper.
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
