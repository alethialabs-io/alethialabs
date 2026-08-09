// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package sandbox

import (
	"context"
	"errors"
	"testing"
)

func TestPassthroughRunsJobInProcessAndWarns(t *testing.T) {
	var warned string
	ran := false
	err := Passthrough{Operator: "self"}.Run(
		context.Background(),
		Spec{Kind: "deploy", JobID: "job-1", Warn: func(s string) { warned = s }},
		func(context.Context) error { ran = true; return nil },
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ran {
		t.Fatal("job was not run")
	}
	if warned == "" {
		t.Fatal("expected a per-job isolation-disabled warning")
	}
}

func TestPassthroughPropagatesJobError(t *testing.T) {
	sentinel := errors.New("boom")
	err := Passthrough{}.Run(context.Background(), Spec{Kind: "plan", JobID: "j"},
		func(context.Context) error { return sentinel })
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected job error to propagate, got %v", err)
	}
}

func TestPassthroughRefusesUnsandboxedOnManagedWhenEnforced(t *testing.T) {
	ran := false
	err := Passthrough{Operator: "managed", EnforceManaged: true}.Run(
		context.Background(),
		Spec{Kind: "deploy", JobID: "j"},
		func(context.Context) error { ran = true; return nil },
	)
	if err == nil {
		t.Fatal("expected refusal on managed runner with EnforceManaged")
	}
	if ran {
		t.Fatal("job must not run when refused")
	}
}

func TestPassthroughAllowsSelfEvenWhenEnforced(t *testing.T) {
	ran := false
	err := Passthrough{Operator: "self", EnforceManaged: true}.Run(
		context.Background(),
		Spec{Kind: "deploy", JobID: "j"},
		func(context.Context) error { ran = true; return nil },
	)
	if err != nil || !ran {
		t.Fatalf("self runner should run even when EnforceManaged (ran=%v err=%v)", ran, err)
	}
}

// TestPassthroughRefusesUnknownOperatorWhenEnforced is the fail-closed inversion: an
// empty/miscased/unknown operator (NOT the explicit "self") must refuse under EnforceManaged
// rather than fall through as if it were self and run untrusted tofu in-process.
func TestPassthroughRefusesUnknownOperatorWhenEnforced(t *testing.T) {
	for _, op := range []string{"", "Managed", "manged", "MANAGED"} {
		ran := false
		err := Passthrough{Operator: op, EnforceManaged: true}.Run(
			context.Background(),
			Spec{Kind: "deploy", JobID: "j"},
			func(context.Context) error { ran = true; return nil },
		)
		if err == nil {
			t.Fatalf("operator %q must refuse under EnforceManaged (only explicit self is lenient)", op)
		}
		if ran {
			t.Fatalf("operator %q: job must not run when refused", op)
		}
	}
}

// TestPassthroughUnknownOperatorRunsWhenNotEnforced pins that the inversion did NOT change
// today's default (EnforceManaged=false) — trusted work still runs in-process regardless of
// the operator string, so existing managed provisioning is unaffected until the flag flips.
func TestPassthroughUnknownOperatorRunsWhenNotEnforced(t *testing.T) {
	ran := false
	err := Passthrough{Operator: "", EnforceManaged: false}.Run(
		context.Background(),
		Spec{Kind: "deploy", JobID: "j"},
		func(context.Context) error { ran = true; return nil },
	)
	if err != nil || !ran {
		t.Fatalf("EnforceManaged=false must run regardless of operator (ran=%v err=%v)", ran, err)
	}
}

// TestPassthroughRefusesNoEgress is the #2042 regression: Spec.NoEgress documents
// "backends that can't enforce it must fail closed rather than silently allow
// egress", and in-process execution can deny nothing — the job would run with the
// runner's full host network and environment. The refusal is UNCONDITIONAL:
// operator "self" and EnforceManaged=false excuse missing isolation for trusted
// work, never a deny-all-egress promise about untrusted work.
func TestPassthroughRefusesNoEgress(t *testing.T) {
	for _, p := range []Passthrough{
		{Operator: "self"},
		{Operator: "self", EnforceManaged: true},
		{Operator: "managed"},
		{},
	} {
		ran := false
		err := p.Run(context.Background(),
			Spec{Kind: "chart_scan", JobID: "j", NoEgress: true},
			func(context.Context) error { ran = true; return nil },
		)
		if err == nil || ran {
			t.Fatalf("Passthrough%+v silently allowed egress for a NoEgress spec (ran=%v err=%v)", p, ran, err)
		}
	}
}
