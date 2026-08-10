// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"io"
	"strings"
	"testing"
)

// hetznerResetFlags clears the package-level flag state so one case cannot leak into the next.
func hetznerResetFlags() {
	connectorHetznerToken = ""
	connectorHetznerTokenStdin = false
	connectorHetznerS3AccessKey = ""
	connectorHetznerS3SecretKey = ""
}

func TestValidateHetznerToken(t *testing.T) {
	good := strings.Repeat("a", 64) // a real Hetzner token's length
	if got, err := validateHetznerToken(good); err != nil || got != good {
		t.Fatalf("validateHetznerToken(valid) = (%q, %v)", got, err)
	}
	for _, tc := range []struct{ name, in, wantMsg string }{
		{"empty", "", "required"},
		{"too short", "abc123", "at least"},
		{"embedded space", strings.Repeat("a", 30) + " " + strings.Repeat("b", 30), "whitespace"},
		{"embedded newline", strings.Repeat("a", 30) + "\n" + strings.Repeat("b", 30), "whitespace"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := validateHetznerToken(tc.in)
			if err == nil {
				t.Fatalf("validateHetznerToken(%q) should fail", tc.in)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Errorf("message %q should mention %q — a vague error here reads as a cloud fault", err, tc.wantMsg)
			}
		})
	}
}

func TestResolveHetznerToken(t *testing.T) {
	good := strings.Repeat("z", 64)

	t.Run("from stdin, trimmed", func(t *testing.T) {
		hetznerResetFlags()
		defer hetznerResetFlags()
		connectorHetznerTokenStdin = true
		// A trailing newline is what `echo $TOKEN | alethia …` actually delivers.
		got, err := resolveHetznerToken(strings.NewReader(good + "\n"))
		if err != nil || got != good {
			t.Fatalf("resolveHetznerToken(stdin) = (%q, %v)", got, err)
		}
	})

	t.Run("from --token", func(t *testing.T) {
		hetznerResetFlags()
		defer hetznerResetFlags()
		connectorHetznerToken = "  " + good + "  "
		got, err := resolveHetznerToken(strings.NewReader(""))
		if err != nil || got != good {
			t.Fatalf("resolveHetznerToken(--token) = (%q, %v)", got, err)
		}
	})

	t.Run("stdin wins over --token", func(t *testing.T) {
		hetznerResetFlags()
		defer hetznerResetFlags()
		connectorHetznerTokenStdin = true
		connectorHetznerToken = strings.Repeat("x", 64)
		got, err := resolveHetznerToken(strings.NewReader(good))
		if err != nil || got != good {
			t.Fatalf("--token-stdin must take precedence: got (%q, %v)", got, err)
		}
	})

	t.Run("an invalid stdin token still fails", func(t *testing.T) {
		hetznerResetFlags()
		defer hetznerResetFlags()
		connectorHetznerTokenStdin = true
		if _, err := resolveHetznerToken(strings.NewReader("short")); err == nil {
			t.Fatal("a short token from stdin must be rejected, not forwarded")
		}
	})

	// With nothing supplied and no TTY the command must say how to supply it, rather than hanging on
	// a prompt that a CI job can never answer.
	t.Run("no token and no TTY names the flags", func(t *testing.T) {
		hetznerResetFlags()
		defer hetznerResetFlags()
		prev := noInputMode
		noInputMode = true
		defer func() { noInputMode = prev }()
		_, err := resolveHetznerToken(strings.NewReader(""))
		if err == nil {
			t.Fatal("expected an error with no token and no TTY")
		}
		for _, want := range []string{"--token", "--token-stdin"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("error %q should name %s", err, want)
			}
		}
	})
}

func TestHetznerCreds(t *testing.T) {
	t.Run("token only omits the S3 keys", func(t *testing.T) {
		got := hetznerCreds("tok", "", "")
		if got["api_token"] != "tok" {
			t.Errorf("api_token missing: %+v", got)
		}
		// Absent, not empty: the server reads absence as "no buckets", where an empty string would be
		// stored as a credential that cannot work.
		for _, k := range []string{"s3_access_key", "s3_secret_key"} {
			if _, present := got[k]; present {
				t.Errorf("%s must be omitted when unset, got %+v", k, got)
			}
		}
	})

	t.Run("carries the S3 pair when given", func(t *testing.T) {
		got := hetznerCreds("tok", "AK", "SK")
		if got["s3_access_key"] != "AK" || got["s3_secret_key"] != "SK" {
			t.Errorf("S3 pair dropped: %+v", got)
		}
	})
}

// errReader fails on read, standing in for a closed or broken stdin.
type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

// TestResolveHetznerTokenStdinReadError covers the read-failure arm: a broken pipe must surface as a
// clear read error, not as an empty token that then fails validation for the wrong reason.
func TestResolveHetznerTokenStdinReadError(t *testing.T) {
	hetznerResetFlags()
	defer hetznerResetFlags()
	connectorHetznerTokenStdin = true
	_, err := resolveHetznerToken(errReader{})
	if err == nil || !strings.Contains(err.Error(), "stdin") {
		t.Fatalf("want a stdin read error, got %v", err)
	}
}
