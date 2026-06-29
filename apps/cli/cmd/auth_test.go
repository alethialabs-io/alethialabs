// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/golang-jwt/jwt/v5"
)

// makeToken returns a signed JWT carrying the given expiry. The CLI parses tokens
// unverified, so the signing key is irrelevant to the tests.
func makeToken(t *testing.T, exp time.Time) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"exp": exp.Unix(),
		"sub": "u1",
	})
	s, err := tok.SignedString([]byte("test-secret"))
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return s
}

// isolatedHome points the user config dir at a fresh temp dir and returns the
// resolved credentials path (with its parent directory created).
func isolatedHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	credsPath, err := getCredentialsPath()
	if err != nil {
		t.Fatalf("creds path: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(credsPath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	return credsPath
}

func TestGetCredentialsPath(t *testing.T) {
	isolatedHome(t)
	p, err := getCredentialsPath()
	if err != nil {
		t.Fatalf("getCredentialsPath: %v", err)
	}
	if !strings.HasSuffix(p, filepath.Join("alethia", "credentials.json")) {
		t.Errorf("unexpected path: %s", p)
	}
}

func TestSaveAndReadCredentials(t *testing.T) {
	credsPath := isolatedHome(t)
	creds := types.ExchangeResponse{AccessToken: "a", RefreshToken: "r", UserEmail: "x@y.com"}
	if err := saveCredentials(credsPath, creds); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}
	data, err := os.ReadFile(credsPath)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var got types.ExchangeResponse
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.AccessToken != "a" || got.UserEmail != "x@y.com" {
		t.Errorf("round-trip mismatch: %+v", got)
	}
}

func TestGetAuthTokenValid(t *testing.T) {
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatal(err)
	}
	got, err := getAuthTokenInternal(false)
	if err != nil {
		t.Fatalf("getAuthTokenInternal: %v", err)
	}
	if got != tok {
		t.Error("expected the stored token back")
	}
}

func TestGetAuthTokenMissingNoPrompt(t *testing.T) {
	isolatedHome(t)
	if _, err := getAuthTokenInternal(false); err == nil {
		t.Error("expected error when no credentials and prompting disabled")
	}
}

func TestGetAuthTokenExpiredNoRefresh(t *testing.T) {
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(-time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: ""}); err != nil {
		t.Fatal(err)
	}
	if _, err := getAuthTokenInternal(false); err == nil {
		t.Error("expected error when expired with no refresh token")
	}
}

func TestGetAuthTokenRefresh(t *testing.T) {
	credsPath := isolatedHome(t)
	newTok := makeToken(t, time.Now().Add(time.Hour))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/cli/refresh" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]string{"access_token": newTok})
	}))
	defer srv.Close()
	os.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	defer os.Unsetenv("ALETHIA_WEB_ORIGIN")

	expired := makeToken(t, time.Now().Add(-time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: expired, RefreshToken: "refresh-tok"}); err != nil {
		t.Fatal(err)
	}

	got, err := getAuthTokenInternal(false)
	if err != nil {
		t.Fatalf("getAuthTokenInternal: %v", err)
	}
	if got != newTok {
		t.Error("expected refreshed token")
	}
}

func TestRefreshAccessToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"access_token": "fresh"})
	}))
	defer srv.Close()
	os.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	defer os.Unsetenv("ALETHIA_WEB_ORIGIN")

	got, err := refreshAccessToken("refresh-tok")
	if err != nil {
		t.Fatalf("refreshAccessToken: %v", err)
	}
	if got != "fresh" {
		t.Errorf("expected fresh, got %q", got)
	}
}

func TestRefreshAccessTokenError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]string{"error": "expired"})
	}))
	defer srv.Close()
	os.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	defer os.Unsetenv("ALETHIA_WEB_ORIGIN")

	if _, err := refreshAccessToken("refresh-tok"); err == nil {
		t.Error("expected error for 401 refresh")
	}
}
