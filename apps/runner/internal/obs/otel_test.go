// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package obs

import (
	"context"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// TestSetup_NoopWhenEndpointUnset asserts that with no OTLP endpoint configured, Setup
// registers NOTHING and returns a safe no-op shutdown — the "unset ⇒ complete no-op"
// contract. No provider is built, so the global tracer/meter stay the API no-op and a
// runner span is a non-recording no-op that costs nothing and exports nothing.
func TestSetup_NoopWhenEndpointUnset(t *testing.T) {
	// Ensure the gating env is clear for this test.
	for _, k := range []string{
		"OTEL_EXPORTER_OTLP_ENDPOINT",
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
		"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
	} {
		t.Setenv(k, "")
	}

	shutdown, err := Setup(context.Background(), "test")
	if err != nil {
		t.Fatalf("Setup returned error when disabled: %v", err)
	}
	if shutdown == nil {
		t.Fatal("Setup returned a nil shutdown func")
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("no-op shutdown returned error: %v", err)
	}

	// The global tracer must be a non-recording no-op (nothing was registered).
	_, span := Tracer().Start(context.Background(), "should-be-noop")
	if span.IsRecording() {
		t.Error("span is recording despite no telemetry provider being registered")
	}
	span.End()
}

// TestSpanContextFromTraceparent asserts the traceparent parse: a valid W3C traceparent
// yields the right trace-id + span-id (sampled, remote); malformed input yields ok=false.
func TestSpanContextFromTraceparent(t *testing.T) {
	const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
	sc, ok := SpanContextFromTraceparent(tp)
	if !ok {
		t.Fatal("valid traceparent parsed as invalid")
	}
	if sc.TraceID().String() != "0af7651916cd43dd8448eb211c80319c" {
		t.Errorf("trace-id = %s, want 0af7651916cd43dd8448eb211c80319c", sc.TraceID())
	}
	if sc.SpanID().String() != "b7ad6b7169203331" {
		t.Errorf("span-id = %s, want b7ad6b7169203331", sc.SpanID())
	}
	if !sc.IsSampled() || !sc.IsRemote() {
		t.Errorf("span context should be sampled + remote: %+v", sc)
	}

	for _, bad := range []string{"", "not-a-traceparent", "00-short-b7ad6b7169203331-01"} {
		if _, ok := SpanContextFromTraceparent(bad); ok {
			t.Errorf("SpanContextFromTraceparent(%q) parsed as valid", bad)
		}
	}
}

// TestRunnerSpanInheritsConsoleTraceparent is the console↔runner JOIN proof on the Go
// side: a span the runner starts from a ctx anchored to the console's traceparent shares
// that traceparent's trace-id and nests under it as a child. Combined with the console
// span carrying the SAME trace-id (see the TS observability test), console + runner spans
// land in ONE distributed trace.
func TestRunnerSpanInheritsConsoleTraceparent(t *testing.T) {
	// The traceparent the console minted at enqueue and stored on the job.
	const consoleTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

	sr := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sr))
	tr := tp.Tracer("test-runner")

	// Anchor to the console traceparent (exactly what executeJob does), then start the
	// runner's per-job span in that context.
	ctx := ContextFromTraceparent(context.Background(), consoleTraceparent)
	_, span := tr.Start(ctx, "job.execute")
	span.End()

	spans := sr.Ended()
	if len(spans) != 1 {
		t.Fatalf("recorded %d spans, want 1", len(spans))
	}
	got := spans[0].SpanContext().TraceID().String()
	if got != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Errorf("runner span trace-id = %s, want the console traceparent's trace-id 4bf92f3577b34da6a3ce929d0e0e4736", got)
	}
	// The runner span must be a CHILD of the traceparent's span-id (the enqueue root).
	if parent := spans[0].Parent().SpanID().String(); parent != "00f067aa0ba902b7" {
		t.Errorf("runner span parent = %s, want the traceparent's span-id 00f067aa0ba902b7", parent)
	}
	if !spans[0].Parent().IsRemote() {
		t.Error("parent should be marked remote (it came from the console over the wire)")
	}
}
