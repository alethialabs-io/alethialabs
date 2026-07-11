// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
)

// selectSandbox's DEFAULT (no-container) path must stay a plain Passthrough today, and
// gain EnforceManaged ONLY when ALETHIA_SANDBOX_ENFORCE_MANAGED is set — the config-driven
// kill-switch the maintainer flips fleet-wide once the container backend is proven (3b).
func TestSelectSandbox_EnforceManagedLever(t *testing.T) {
	t.Setenv("ALETHIA_SANDBOX_BACKEND", "") // default (no isolation) path

	t.Run("default: EnforceManaged off (trusted managed provisioning unaffected)", func(t *testing.T) {
		t.Setenv("ALETHIA_SANDBOX_ENFORCE_MANAGED", "")
		s := selectSandbox(Config{Operator: "managed"})
		p, ok := s.(sandbox.Passthrough)
		if !ok {
			t.Fatalf("expected Passthrough, got %T", s)
		}
		if p.EnforceManaged {
			t.Error("EnforceManaged must be false by default (else prod managed provisioning breaks)")
		}
	})

	t.Run("lever set: EnforceManaged on (refuses managed-unsandboxed)", func(t *testing.T) {
		t.Setenv("ALETHIA_SANDBOX_ENFORCE_MANAGED", "1")
		s := selectSandbox(Config{Operator: "managed"})
		p, ok := s.(sandbox.Passthrough)
		if !ok {
			t.Fatalf("expected Passthrough, got %T", s)
		}
		if !p.EnforceManaged {
			t.Error("EnforceManaged must be true when ALETHIA_SANDBOX_ENFORCE_MANAGED=1")
		}
		if p.Operator != "managed" {
			t.Errorf("Operator = %q, want managed", p.Operator)
		}
	})
}
