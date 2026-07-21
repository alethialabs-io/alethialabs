// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"os"
	"testing"
)

func TestTokenFromEnv(t *testing.T) {
	t.Run("returns the first non-empty provider var", func(t *testing.T) {
		t.Setenv("DIGITALOCEAN_ACCESS_TOKEN", "")
		t.Setenv("DIGITALOCEAN_TOKEN", "second")
		if got := tokenFromEnv("digitalocean"); got != "second" {
			t.Fatalf("tokenFromEnv = %q, want second", got)
		}
	})
	t.Run("empty when none set", func(t *testing.T) {
		t.Setenv("HCLOUD_TOKEN", "")
		if got := tokenFromEnv("hetzner"); got != "" {
			t.Fatalf("tokenFromEnv = %q, want empty", got)
		}
	})
	t.Run("empty for an unknown provider", func(t *testing.T) {
		if got := tokenFromEnv("nimbus"); got != "" {
			t.Fatalf("tokenFromEnv(unknown) = %q, want empty", got)
		}
	})
}

func TestActivateTokenCloud_UnsupportedProvider(t *testing.T) {
	if _, err := ActivateTokenCloud("nimbus", "tok", false); err == nil {
		t.Fatal("expected an error for an unsupported token cloud")
	}
}

func TestActivateTokenCloud_Managed(t *testing.T) {
	// Register the vars so t.Setenv restores them even though the function os.Setenv's them.
	t.Setenv("HCLOUD_TOKEN", "")
	cleanup, err := ActivateTokenCloud("hetzner", "hc-secret", false)
	if err != nil {
		t.Fatalf("ActivateTokenCloud: %v", err)
	}
	if got := os.Getenv("HCLOUD_TOKEN"); got != "hc-secret" {
		t.Fatalf("HCLOUD_TOKEN = %q, want hc-secret", got)
	}
	cleanup()
	if got := os.Getenv("HCLOUD_TOKEN"); got != "" {
		t.Fatalf("after cleanup HCLOUD_TOKEN = %q, want empty", got)
	}
}

func TestActivateTokenCloud_ManagedEmptyToken(t *testing.T) {
	if _, err := ActivateTokenCloud("civo", "", false); err == nil {
		t.Fatal("expected an error for an empty API token")
	}
}

func TestActivateTokenCloud_SelfManaged(t *testing.T) {
	t.Run("token present in env → no-op cleanup, untouched", func(t *testing.T) {
		t.Setenv("CIVO_TOKEN", "already-here")
		cleanup, err := ActivateTokenCloud("civo", "", true)
		if err != nil {
			t.Fatalf("ActivateTokenCloud self-managed: %v", err)
		}
		cleanup()
		// The customer's own token must NOT be cleared by the no-op cleanup.
		if got := os.Getenv("CIVO_TOKEN"); got != "already-here" {
			t.Fatalf("CIVO_TOKEN = %q, want it preserved (already-here)", got)
		}
	})
	t.Run("token absent from env → error", func(t *testing.T) {
		t.Setenv("CIVO_TOKEN", "")
		if _, err := ActivateTokenCloud("civo", "", true); err == nil {
			t.Fatal("expected an error when the self-managed runner has no token set")
		}
	})
}

func TestActivateHetznerS3(t *testing.T) {
	t.Run("empty keys are a no-op", func(t *testing.T) {
		t.Setenv("HETZNER_S3_ACCESS_KEY", "")
		cleanup := ActivateHetznerS3("", "sk")
		cleanup()
		if got := os.Getenv("HETZNER_S3_ACCESS_KEY"); got != "" {
			t.Fatalf("HETZNER_S3_ACCESS_KEY = %q, want untouched (empty)", got)
		}
	})
	t.Run("sets both keys and cleanup unsets them", func(t *testing.T) {
		t.Setenv("HETZNER_S3_ACCESS_KEY", "")
		t.Setenv("HETZNER_S3_SECRET_KEY", "")
		cleanup := ActivateHetznerS3("ak", "sk")
		if os.Getenv("HETZNER_S3_ACCESS_KEY") != "ak" || os.Getenv("HETZNER_S3_SECRET_KEY") != "sk" {
			t.Fatalf("keys not set: ak=%q sk=%q", os.Getenv("HETZNER_S3_ACCESS_KEY"), os.Getenv("HETZNER_S3_SECRET_KEY"))
		}
		cleanup()
		if os.Getenv("HETZNER_S3_ACCESS_KEY") != "" || os.Getenv("HETZNER_S3_SECRET_KEY") != "" {
			t.Fatal("cleanup did not unset the keys it set")
		}
	})
	t.Run("respects a self-hosted runner's pre-set key", func(t *testing.T) {
		t.Setenv("HETZNER_S3_ACCESS_KEY", "customer-ak")
		t.Setenv("HETZNER_S3_SECRET_KEY", "")
		cleanup := ActivateHetznerS3("ak", "sk")
		if got := os.Getenv("HETZNER_S3_ACCESS_KEY"); got != "customer-ak" {
			t.Fatalf("pre-set access key overwritten: %q", got)
		}
		if got := os.Getenv("HETZNER_S3_SECRET_KEY"); got != "sk" {
			t.Fatalf("unset secret key = %q, want sk", got)
		}
		cleanup()
		// The customer's pre-set key must survive cleanup; only the one we set is unset.
		if got := os.Getenv("HETZNER_S3_ACCESS_KEY"); got != "customer-ak" {
			t.Fatalf("cleanup cleared the customer's pre-set key: %q", got)
		}
	})
}
