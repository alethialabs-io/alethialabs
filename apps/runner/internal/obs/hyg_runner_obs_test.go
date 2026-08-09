// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package obs

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"go.opentelemetry.io/otel"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

// hygRunnerObsCollector is a stand-in OTLP/HTTP collector: it accepts any export and
// records the signal paths it was called on, so a test can assert WHICH signals were
// shipped without decoding protobuf.
type hygRunnerObsCollector struct {
	*httptest.Server
	mu    sync.Mutex
	paths []string
}

// hygRunnerObsNewCollector starts a recording collector and stops it when the test ends.
func hygRunnerObsNewCollector(t *testing.T) *hygRunnerObsCollector {
	t.Helper()
	c := &hygRunnerObsCollector{}
	c.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		c.mu.Lock()
		c.paths = append(c.paths, req.URL.Path)
		c.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(c.Close)
	return c
}

// hygRunnerObsGot reports whether the collector received an export on the given signal path.
func (c *hygRunnerObsCollector) hygRunnerObsGot(path string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, p := range c.paths {
		if p == path {
			return true
		}
	}
	return false
}

// hygRunnerObsIsolateGlobals pins the process-global tracer/meter/propagator to the API
// no-ops for the duration of the test and restores whatever was there afterwards. Both
// halves matter: the reset makes "Setup registered nothing for this signal" a decidable
// question even if an earlier test left a live SDK provider behind, and the restore keeps
// this test from leaking one into the next.
func hygRunnerObsIsolateGlobals(t *testing.T) {
	t.Helper()
	tp, mp, prop := otel.GetTracerProvider(), otel.GetMeterProvider(), otel.GetTextMapPropagator()
	t.Cleanup(func() {
		otel.SetTracerProvider(tp)
		otel.SetMeterProvider(mp)
		otel.SetTextMapPropagator(prop)
	})
	otel.SetTracerProvider(tracenoop.NewTracerProvider())
	otel.SetMeterProvider(metricnoop.NewMeterProvider())
}

// hygRunnerObsPipelines reports which SDK pipelines are currently registered globally — a
// provider is an SDK provider only if Setup constructed it, so this is the direct read of
// "was this signal's pipeline built?".
func hygRunnerObsPipelines() (traces, metrics bool) {
	_, traces = otel.GetTracerProvider().(*sdktrace.TracerProvider)
	_, metrics = otel.GetMeterProvider().(*sdkmetric.MeterProvider)
	return traces, metrics
}

// TestHygRunnerObsSignalsGateIndependently walks every combination of the three OTLP
// endpoint vars and asserts Setup builds EXACTLY the signals that have an endpoint of
// their own (the signal-specific var, or the generic var that stands in for both).
//
// Before the fix Setup OR'd the three vars into one on/off switch and then built both
// pipelines unconditionally, so "traces only" also booted a metric pipeline with no
// endpoint — which the SDK aims at its default https://localhost:4318 and re-exports every
// 15s forever. The "traces only" and "metrics only" rows fail on that code.
func TestHygRunnerObsSignalsGateIndependently(t *testing.T) {
	const (
		tracesPath  = "/v1/traces"
		metricsPath = "/v1/metrics"
	)

	cases := []struct {
		name       string
		generic    bool // OTEL_EXPORTER_OTLP_ENDPOINT points at the collector
		traces     bool // OTEL_EXPORTER_OTLP_TRACES_ENDPOINT points at the collector
		metrics    bool // OTEL_EXPORTER_OTLP_METRICS_ENDPOINT points at the collector
		wantTraces bool
		wantMetric bool
	}{
		{name: "no endpoint at all"},
		{name: "generic only", generic: true, wantTraces: true, wantMetric: true},
		{name: "traces only", traces: true, wantTraces: true},
		{name: "metrics only", metrics: true, wantMetric: true},
		{name: "both signal vars", traces: true, metrics: true, wantTraces: true, wantMetric: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hygRunnerObsIsolateGlobals(t)
			col := hygRunnerObsNewCollector(t)

			// Precondition: nothing is registered yet, so a positive read below can only
			// come from this Setup call.
			if traces, metrics := hygRunnerObsPipelines(); traces || metrics {
				t.Fatalf("precondition: SDK pipelines already registered (traces=%v metrics=%v)", traces, metrics)
			}

			t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
			t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
			t.Setenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "")
			if tc.generic {
				t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", col.URL)
			}
			if tc.traces {
				t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", col.URL+tracesPath)
			}
			if tc.metrics {
				t.Setenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", col.URL+metricsPath)
			}

			shutdown, err := Setup(context.Background(), "v-test")
			if err != nil {
				t.Fatalf("Setup: %v", err)
			}
			if shutdown == nil {
				t.Fatal("Setup returned a nil shutdown func")
			}

			gotTraces, gotMetric := hygRunnerObsPipelines()
			if gotTraces != tc.wantTraces {
				t.Errorf("trace pipeline built = %v, want %v", gotTraces, tc.wantTraces)
			}
			if gotMetric != tc.wantMetric {
				t.Errorf("metric pipeline built = %v, want %v", gotMetric, tc.wantMetric)
			}

			// The API-level consequence: a span only records, and a counter only reaches a
			// real meter, for a signal that was actually enabled.
			_, span := Tracer().Start(context.Background(), "stage.plan")
			if span.IsRecording() != tc.wantTraces {
				t.Errorf("span recording = %v, want %v", span.IsRecording(), tc.wantTraces)
			}
			span.End()

			counter, cerr := otel.Meter("alethia-runner").Int64Counter("alethia.gate_block")
			if cerr != nil {
				t.Fatalf("Int64Counter: %v", cerr)
			}
			counter.Add(context.Background(), 1)

			// Shutdown drains only the pipelines that were started — it must not panic on,
			// or wait for, a signal that was never built.
			if serr := shutdown(context.Background()); serr != nil {
				t.Fatalf("shutdown: %v", serr)
			}
			if col.hygRunnerObsGot(tracesPath) != tc.wantTraces {
				t.Errorf("collector saw a trace export = %v, want %v", col.hygRunnerObsGot(tracesPath), tc.wantTraces)
			}
			if col.hygRunnerObsGot(metricsPath) != tc.wantMetric {
				t.Errorf("collector saw a metric export = %v, want %v", col.hygRunnerObsGot(metricsPath), tc.wantMetric)
			}
		})
	}
}

// TestHygRunnerObsShutdownReportsFirstFailure asserts the shutdown func surfaces an error
// from a pipeline it tore down rather than swallowing it — a second shutdown of a live
// metric pipeline is rejected by the reader, and that error must reach the caller.
func TestHygRunnerObsShutdownReportsFirstFailure(t *testing.T) {
	hygRunnerObsIsolateGlobals(t)
	col := hygRunnerObsNewCollector(t)

	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", col.URL+"/v1/metrics")

	shutdown, err := Setup(context.Background(), "v-test")
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if serr := shutdown(context.Background()); serr != nil {
		t.Fatalf("first shutdown: %v", serr)
	}
	if serr := shutdown(context.Background()); serr == nil {
		t.Error("second shutdown returned nil; the already-shutdown reader's error was swallowed")
	}
}

// TestHygRunnerObsContextFromTraceparentIgnoresMalformed asserts a malformed traceparent
// leaves ctx untouched — the runner must not anchor a job to a bogus parent.
func TestHygRunnerObsContextFromTraceparentIgnoresMalformed(t *testing.T) {
	base := context.Background()
	for _, bad := range []string{"", "garbage", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7"} {
		if got := ContextFromTraceparent(base, bad); got != base {
			t.Errorf("ContextFromTraceparent(%q) modified the context", bad)
		}
	}
}
