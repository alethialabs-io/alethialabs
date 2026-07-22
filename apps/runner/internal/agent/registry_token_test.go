// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDockerConfigJSON(t *testing.T) {
	got := dockerConfigJSON("myreg.example.com", "AWS", "s3cr3t")
	var doc struct {
		Auths map[string]struct{ Username, Password, Auth string } `json:"auths"`
	}
	if err := json.Unmarshal([]byte(got), &doc); err != nil {
		t.Fatalf("not valid json: %v\n%s", err, got)
	}
	e, ok := doc.Auths["myreg.example.com"]
	if !ok {
		t.Fatalf("missing host entry: %s", got)
	}
	if e.Username != "AWS" || e.Password != "s3cr3t" {
		t.Errorf("entry = %+v", e)
	}
	if want := base64.StdEncoding.EncodeToString([]byte("AWS:s3cr3t")); e.Auth != want {
		t.Errorf("auth = %q want %q", e.Auth, want)
	}
}

func TestRegistryPatchJSON_TokenNotPlaintext(t *testing.T) {
	dcj := dockerConfigJSON("r.io", "AWS", "SUPER-SECRET-TOKEN")
	patch := registryPatchJSON(dcj)
	// The patch must carry the payload base64'd under data..dockerconfigjson — never plaintext.
	if strings.Contains(patch, "SUPER-SECRET-TOKEN") {
		t.Fatalf("raw token leaked into patch: %s", patch)
	}
	var p struct {
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal([]byte(patch), &p); err != nil {
		t.Fatalf("patch not json: %v", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(p.Data[".dockerconfigjson"])
	if err != nil {
		t.Fatalf("data not base64: %v", err)
	}
	if string(decoded) != dcj {
		t.Errorf("round-trip mismatch")
	}
}

func TestDecodeECRAuth(t *testing.T) {
	tok := base64.StdEncoding.EncodeToString([]byte("AWS:pw123"))
	u, p, err := decodeECRAuth(tok)
	if err != nil || u != "AWS" || p != "pw123" {
		t.Fatalf("decodeECRAuth = (%q,%q,%v)", u, p, err)
	}
	if _, _, err := decodeECRAuth(base64.StdEncoding.EncodeToString([]byte("no-colon"))); err == nil {
		t.Error("expected error for malformed token (no colon)")
	}
	if _, _, err := decodeECRAuth("!!!not-base64"); err == nil {
		t.Error("expected error for non-base64 token")
	}
}

func TestExchangeACRRefreshToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		if r.FormValue("grant_type") != "access_token" || r.FormValue("access_token") != "aad-tok" {
			t.Errorf("unexpected form: %v", r.Form)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"refresh_token":"acr-refresh-xyz"}`))
	}))
	defer srv.Close()
	host := strings.TrimPrefix(srv.URL, "https://")
	// Point the exchange at the test server (it uses https://<host>/oauth2/exchange).
	rt, err := exchangeACRRefreshTokenAt(context.Background(), srv.Client(), srv.URL+"/oauth2/exchange", host, "aad-tok")
	if err != nil || rt != "acr-refresh-xyz" {
		t.Fatalf("exchange = (%q,%v)", rt, err)
	}

	// Non-200 fails.
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(403) }))
	defer bad.Close()
	if _, err := exchangeACRRefreshTokenAt(context.Background(), bad.Client(), bad.URL, "h", "t"); err == nil {
		t.Error("expected error on non-200")
	}

	// Empty refresh_token fails.
	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer empty.Close()
	if _, err := exchangeACRRefreshTokenAt(context.Background(), empty.Client(), empty.URL, "h", "t"); err == nil {
		t.Error("expected error on empty refresh_token")
	}
}

func TestIsACRHost(t *testing.T) {
	ok := []string{"acme.azurecr.io", "ACME.AZURECR.IO", "my-reg.azurecr.io"}
	bad := []string{
		"", "evil.com", "acme.azurecr.io.evil.com", "acme.azurecr.io/x",
		"acme.azurecr.io:443", "acme.azurecr.io?a=b", "user@acme.azurecr.io",
		"acme.azurecr.io#frag", "acme.azurecr.io ",
	}
	for _, h := range ok {
		if !isACRHost(h) {
			t.Errorf("isACRHost(%q) = false, want true", h)
		}
	}
	for _, h := range bad {
		if isACRHost(h) {
			t.Errorf("isACRHost(%q) = true, want false (token would be sent to a non-ACR host)", h)
		}
	}
}

func TestMintACRRejectsNonACRHost(t *testing.T) {
	// A non-ACR host must fail closed BEFORE any AAD token is minted/sent.
	if _, _, err := mintACRDockerConfig(context.Background(), "evil.example.com"); err == nil {
		t.Fatal("expected mintACRDockerConfig to reject a non-ACR host")
	}
}

func TestRunRegistryTokenLoop_Once(t *testing.T) {
	var patched []string
	patch := func(ctx context.Context, ns, name, dcj string) error {
		patched = append(patched, ns+"/"+name)
		if !strings.Contains(dcj, "oauth2accesstoken") {
			t.Errorf("patched with unexpected dcj: %s", dcj)
		}
		return nil
	}
	mint := func(ctx context.Context) (string, time.Time, error) {
		return dockerConfigJSON("r.io", "oauth2accesstoken", "tok"), time.Now().Add(time.Hour), nil
	}
	if err := runRegistryTokenLoop(context.Background(), mint, patch, "default", "gar-xacct-pull", true); err != nil {
		t.Fatalf("loop: %v", err)
	}
	if len(patched) != 1 || patched[0] != "default/gar-xacct-pull" {
		t.Fatalf("patched = %v", patched)
	}
}

func TestRunRegistryTokenLoop_InitialMintFatal(t *testing.T) {
	mint := func(ctx context.Context) (string, time.Time, error) {
		return "", time.Time{}, context.DeadlineExceeded
	}
	called := false
	patch := func(ctx context.Context, ns, name, dcj string) error { called = true; return nil }
	if err := runRegistryTokenLoop(context.Background(), mint, patch, "default", "s", true); err == nil {
		t.Fatal("expected fatal error on initial mint failure")
	}
	if called {
		t.Error("patch must not run when the initial mint fails")
	}
}
