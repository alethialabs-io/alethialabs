// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func ptr(s string) *string { return &s }

// The status word is the whole content of the column, so the precedence between "revoked" and
// "expired" is a real decision rather than a formatting detail. Both mean inactive; only one means
// somebody acted.
func TestTokenStatusPrefersRevokedOverExpired(t *testing.T) {
	past := time.Now().Add(-24 * time.Hour).Format(time.RFC3339)
	future := time.Now().Add(24 * time.Hour).Format(time.RFC3339)

	cases := []struct {
		name string
		in   api.ServiceToken
		want string
	}{
		{"nothing set", api.ServiceToken{}, "active"},
		{"expiry in the future", api.ServiceToken{ExpiresAt: ptr(future)}, "active"},
		{"expiry in the past", api.ServiceToken{ExpiresAt: ptr(past)}, "expired"},
		{"revoked", api.ServiceToken{RevokedAt: ptr(past)}, "revoked"},
		// A token revoked in response to a leak must NEVER be reported as having merely aged out.
		// Which of the two happened is the fact an incident needs.
		{"revoked AND expired", api.ServiceToken{RevokedAt: ptr(past), ExpiresAt: ptr(past)}, "revoked"},
		// Empty strings are what a JSON null becomes on some paths; they must not read as "set".
		{"empty revoked string is not revoked", api.ServiceToken{RevokedAt: ptr("")}, "active"},
		{"empty expiry string is not expired", api.ServiceToken{ExpiresAt: ptr("")}, "active"},
		// An unparseable timestamp must not silently become "expired" — that would report a live
		// token as dead and send somebody to mint a replacement they do not need.
		{"unparseable expiry stays active", api.ServiceToken{ExpiresAt: ptr("soon-ish")}, "active"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tokenStatus(tc.in); got != tc.want {
				t.Errorf("tokenStatus = %q, want %q", got, tc.want)
			}
		})
	}
}

// "never" and "—" are not interchangeable. A token that has NEVER been used is the most actionable
// row in the list — the one somebody minted, put somewhere wrong, and forgot — and a dash reads as
// missing data rather than as a finding.
func TestStampRenderingDistinguishesNeverFromAbsent(t *testing.T) {
	if got := stampOrNever(nil); got != "never" {
		t.Errorf("an unused token renders %q, want \"never\"", got)
	}
	if got := stampOrNever(ptr("   ")); got != "never" {
		t.Errorf("whitespace renders %q, want \"never\"", got)
	}
	if got := stampOrDash(nil); got != "—" {
		t.Errorf("an absent timestamp renders %q, want an em dash", got)
	}
	stamp := "2026-08-26T09:41:00Z"
	if got := stampOrDash(&stamp); got != "2026-08-26 09:41" {
		t.Errorf("stampOrDash = %q, want the UTC minute", got)
	}
	// An unparseable value is shown VERBATIM rather than swallowed: a reader can act on a weird
	// string, and cannot act on a dash that hid one.
	if got := stampOrDash(ptr("tomorrow")); got != "tomorrow" {
		t.Errorf("an unparseable stamp renders %q, want it verbatim", got)
	}
}

// The API type must not carry a field that implies the plaintext is retrievable. It is not: the
// server stores only a SHA-256, and no route reads it back. A `Token` field on the LIST type would
// quietly promise otherwise, and somebody would eventually build against the promise.
func TestServiceTokenListTypeCarriesNoSecret(t *testing.T) {
	rows := tokenRows([]api.ServiceToken{{
		ID: "id-1", Name: "ci", TokenPrefix: "alethia_sat_abc12345",
		CreatedAt: "2026-08-26T09:41:00Z",
	}})
	if len(rows) != 1 {
		t.Fatalf("want 1 row, got %d", len(rows))
	}
	joined := strings.Join(rows[0], "|")
	// The PREFIX is fine to show — it is how a reader matches a row against a leaked string. What
	// must never appear is a full-length secret.
	if strings.Contains(joined, "alethia_sat_") && len(rows[0][2]) > len("alethia_sat_")+12 {
		t.Errorf("the prefix column looks like a full token: %q", rows[0][2])
	}
	if !strings.Contains(joined, "never") {
		t.Errorf("a never-used token must say so, got %q", joined)
	}
}
