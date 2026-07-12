// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package telemetry is the OpenTelemetry instrumentation seam used by the provisioner
// (packages/core). It touches only the OTel *API* (never the SDK): spans + metrics are
// read from the GLOBAL tracer/meter providers, which the RUNNER configures (apps/runner
// internal/obs) when an OTLP endpoint is set. When nothing configured a provider — the
// default, endpoint-unset state, and always in the CLI — the global providers are the
// API's built-in no-op, so `StartStage`/`GateBlocked` cost nothing and export nothing.
//
// This keeps packages/core free of the OTel SDK (only the light, stable API), so the
// stage spans + the verify-gate-block metric live right at the source in deploy.go
// without dragging exporters into every consumer of core.
package telemetry

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

// scope is the instrumentation-scope name spans + metrics from core are tagged with.
const scope = "github.com/alethialabs-io/alethialabs/packages/core"

// Tracer returns the provisioner's tracer (the global tracer; no-op until the runner
// registers a provider).
func Tracer() trace.Tracer { return otel.Tracer(scope) }

// StartStage starts a provisioning-stage span as a child of ctx's active span, tagged
// with the low-cardinality stage name. Returns the derived context (carrying the new
// span) and the span; the caller MUST End it. A no-op span when no provider is set.
//
// Stage is one of the fixed provisioning phases: plan, verify_gate, apply,
// kube_configure, argocd, addons.
func StartStage(ctx context.Context, stage string) (context.Context, trace.Span) {
	return Tracer().Start(ctx, "provision."+stage,
		trace.WithAttributes(attribute.String("stage", stage)))
}

// gateBlocked counts applies blocked by the fail-closed verification gate. Created from
// the global meter (no-op until the runner registers a provider). The delegating global
// meter upgrades this instrument in place once a real provider is set, so creating it at
// init — before the runner's obs.Setup runs — is safe.
var gateBlocked, _ = otel.Meter(scope).Int64Counter(
	"alethia.verify.gate_blocked",
	metric.WithDescription("Applies blocked by the fail-closed verification gate"),
	metric.WithUnit("{block}"),
)

// GateBlocked increments the verification-gate block counter, labelled by the
// low-cardinality provider only (NEVER a job_id / trace_id / env_id). A no-op when no
// meter provider is configured.
func GateBlocked(ctx context.Context, provider string) {
	if provider == "" {
		provider = "unknown"
	}
	gateBlocked.Add(ctx, 1, metric.WithAttributes(attribute.String("provider", provider)))
}
