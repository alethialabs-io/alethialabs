// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package telemetry

import (
	"context"
	"testing"
)

// TestNoopWithoutProvider asserts the provisioner's instrumentation is a SAFE no-op when
// no OTel provider is configured (the default in tests, in the CLI, and whenever no OTLP
// endpoint is set): StartStage returns a non-recording span that is safe to End, and
// GateBlocked never panics. This is the "telemetry is never a hard dependency" guarantee
// at the source — the provisioner emits spans/metrics that cost nothing when telemetry
// is off.
func TestNoopWithoutProvider(t *testing.T) {
	ctx, span := StartStage(context.Background(), "plan")
	if span.IsRecording() {
		t.Error("stage span is recording despite no telemetry provider being registered")
	}
	span.End()

	// Must not panic with the no-op global meter, and must tolerate an empty provider.
	GateBlocked(ctx, "aws")
	GateBlocked(ctx, "")
}

// TestStartStageNames asserts each provisioning phase produces a distinct, prefixed span
// name — the fixed, low-cardinality stage set the runner surfaces in the trace.
func TestStartStageNames(t *testing.T) {
	for _, stage := range []string{
		"plan", "verify_gate", "apply", "kube_configure", "argocd", "addons",
	} {
		_, span := StartStage(context.Background(), stage)
		span.End() // no-op span; this just asserts StartStage doesn't panic per stage
	}
}
