// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

const (
	kmCluster = "11111111-1111-4111-8111-111111111111"
	kmMint    = "22222222-2222-4222-8222-222222222222"
)

// TestRequestKubeconfigMint_PostsTheBodyAndReadsThe202 pins the request route's wire: POST to the
// cluster's path, JSON body with only the four contract fields, auth applied, and a 202 decoded.
func TestRequestKubeconfigMint_PostsTheBodyAndReadsThe202(t *testing.T) {
	isolateConfigDir(t)
	var gotBody map[string]any
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != http.MethodPost || r.URL.Path != "/api/cli/clusters/"+kmCluster+"/kubeconfig" {
			t.Errorf("got %s %s", r.Method, r.URL.Path)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("content-type %q", ct)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, `{"mint":{"id":"`+kmMint+`","cluster_id":"`+kmCluster+`","job_id":"j","tier":"readonly","shape":"exec","ttl_seconds":3600,"status":"pending","expires_at":"2026-10-02T10:10:00Z"}}`)
	}))
	resp, err := c.RequestKubeconfigMint(kmCluster, types.KubeconfigMintRequest{
		Tier: types.KubeconfigMintTierReadonly, Shape: types.KubeconfigMintShapeExec, TTLSeconds: 3600, ClientPublicKey: "pk",
	})
	if err != nil {
		t.Fatalf("RequestKubeconfigMint: %v", err)
	}
	if resp.Mint.ID != kmMint || resp.Mint.Status != types.KubeconfigMintStatusPending {
		t.Errorf("decoded %+v", resp.Mint)
	}
	if len(gotBody) != 4 || gotBody["client_public_key"] != "pk" || gotBody["shape"] != "exec" {
		t.Errorf("body %v", gotBody)
	}
}

// TestRequestKubeconfigMint_A200IsNotAccepted: the route's success is 202 and nothing else. A 200
// would be some other handler (a proxy's landing page, an older console) and must not be decoded
// as a queued mint.
func TestRequestKubeconfigMint_A200IsNotAccepted(t *testing.T) {
	isolateConfigDir(t)
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"mint":{}}`)
	}))
	_, err := c.RequestKubeconfigMint(kmCluster, types.KubeconfigMintRequest{})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusOK {
		t.Fatalf("want an APIError for a 200, got %v", err)
	}
}

// TestRequestKubeconfigMint_429CarriesRetryAfter: the rate limit's wait reaches the caller.
func TestRequestKubeconfigMint_429CarriesRetryAfter(t *testing.T) {
	isolateConfigDir(t)
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "600")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":"Too many kubeconfig mint requests"}`)
	}))
	_, err := c.RequestKubeconfigMint(kmCluster, types.KubeconfigMintRequest{})
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("want APIError, got %v", err)
	}
	if apiErr.StatusCode != 429 || apiErr.RetryAfter != 10*time.Minute || !strings.Contains(apiErr.Message, "Too many") {
		t.Errorf("got %+v", apiErr)
	}
}

// TestRequestKubeconfigMint_OtherRefusalsHaveNoRetryAfter: only a 429 reads the header.
func TestRequestKubeconfigMint_OtherRefusalsHaveNoRetryAfter(t *testing.T) {
	isolateConfigDir(t)
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "600")
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":"not provisioned"}`)
	}))
	_, err := c.RequestKubeconfigMint(kmCluster, types.KubeconfigMintRequest{})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != 409 || apiErr.RetryAfter != 0 {
		t.Fatalf("got %v", err)
	}
}

// TestPollKubeconfigMint_DecodesAndValidates: a well-formed ready poll decodes; one that breaks its
// own status's promise is refused.
func TestPollKubeconfigMint_DecodesAndValidates(t *testing.T) {
	isolateConfigDir(t)
	body := `{"status":"ready","private_endpoint":true,"sealed":"abc"}`
	c := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != http.MethodGet || r.URL.Path != "/api/cli/clusters/"+kmCluster+"/kubeconfig/"+kmMint {
			t.Errorf("got %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Content-Type") != "" {
			t.Errorf("a GET carries no content-type")
		}
		_, _ = io.WriteString(w, body)
	}))
	p, err := c.PollKubeconfigMint(kmCluster, kmMint)
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if p.Status != types.KubeconfigMintStatusReady || p.Sealed != "abc" || p.PrivateEndpoint == nil || !*p.PrivateEndpoint {
		t.Errorf("decoded %+v", p)
	}

	body = `{"status":"ready","private_endpoint":false}`
	if _, err := c.PollKubeconfigMint(kmCluster, kmMint); !errors.Is(err, types.ErrKubeconfigMintInvalid) {
		t.Errorf("a ready poll without ciphertext must be refused, got %v", err)
	}
}

// TestPollKubeconfigMint_TransportAndDecodeFailures covers the remaining failure arms: a request
// that cannot be built, a refusal, and a body that is not JSON.
func TestPollKubeconfigMint_TransportAndDecodeFailures(t *testing.T) {
	c := newRefusingClient(t)
	if _, err := c.PollKubeconfigMint(kmCluster, kmMint); err == nil || !strings.Contains(err.Error(), "control plane exploded") {
		t.Errorf("refusal: %v", err)
	}

	c = newUnbuildableClient(t)
	if _, err := c.PollKubeconfigMint(kmCluster, kmMint); err == nil || !strings.Contains(err.Error(), "failed to create request") {
		t.Errorf("unbuildable: %v", err)
	}
	if _, err := c.RequestKubeconfigMint(kmCluster, types.KubeconfigMintRequest{}); err == nil {
		t.Errorf("unbuildable request: want an error")
	}

	isolateConfigDir(t)
	c = newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `not json`)
	}))
	if _, err := c.PollKubeconfigMint(kmCluster, kmMint); err == nil || !strings.Contains(err.Error(), "decode") {
		t.Errorf("decode: %v", err)
	}

	isolateConfigDir(t)
	t.Setenv("ALETHIA_WEB_ORIGIN", "http://127.0.0.1:1")
	c = NewClient("t")
	if _, err := c.PollKubeconfigMint(kmCluster, kmMint); err == nil || !strings.Contains(err.Error(), "failed to send request") {
		t.Errorf("send: %v", err)
	}
}

// TestParseRetryAfter covers both RFC 9110 forms and every refusal.
func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 10, 2, 10, 0, 0, 0, time.UTC)
	cases := map[string]time.Duration{
		"":                              0,
		"  ":                            0,
		"30":                            30 * time.Second,
		"0":                             0,
		"-5":                            0,
		"soon":                          0,
		"Fri, 02 Oct 2026 10:01:00 GMT": time.Minute,
		"Fri, 02 Oct 2026 09:59:00 GMT": 0,
	}
	for in, want := range cases {
		if got := parseRetryAfter(in, now); got != want {
			t.Errorf("parseRetryAfter(%q) = %v, want %v", in, got, want)
		}
	}
}
