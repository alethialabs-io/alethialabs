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
	"go.opentelemetry.io/otel/propagation"
)

// otlpRecorder is a stand-in OTLP/HTTP collector: it accepts any export and records the
// signal paths it was called on, so a test can assert WHAT was shipped without decoding
// protobuf.
type otlpRecorder struct {
	*httptest.Server
	mu    sync.Mutex
	paths []string
}

// newOTLPRecorder starts a recording collector and stops it when the test ends.
func newOTLPRecorder(t *testing.T) *otlpRecorder {
	t.Helper()
	r := &otlpRecorder{}
	r.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.mu.Lock()
		r.paths = append(r.paths, req.URL.Path)
		r.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(r.Close)
	return r
}

// hit reports whether the collector received an export on the given signal path.
func (r *otlpRecorder) hit(path string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.paths {
		if p == path {
			return true
		}
	}
	return false
}

// restoreGlobalTelemetry captures the process-global tracer/meter/propagator and puts them
// back when the test ends, so a test that boots the real SDK cannot leak a live provider
// into the package's other tests (which assert the endpoint-unset no-op contract).
func restoreGlobalTelemetry(t *testing.T) {
	t.Helper()
	tp, mp, prop := otel.GetTracerProvider(), otel.GetMeterProvider(), otel.GetTextMapPropagator()
	t.Cleanup(func() {
		otel.SetTracerProvider(tp)
		otel.SetMeterProvider(mp)
		otel.SetTextMapPropagator(prop)
	})
}

// TestSetup_EnabledByEachEndpointVar walks the three env vars that open the telemetry gate
// and asserts each one boots a REAL pipeline: the global tracer records, and the returned
// shutdown flushes buffered spans + metrics to the configured collector before returning.
func TestSetup_EnabledByEachEndpointVar(t *testing.T) {
	endpointVars := []string{
		"OTEL_EXPORTER_OTLP_ENDPOINT",
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
		"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
	}

	for _, gate := range endpointVars {
		t.Run(gate, func(t *testing.T) {
			restoreGlobalTelemetry(t)
			rec := newOTLPRecorder(t)

			// Point EVERY signal at the recorder, then let `gate` be the variable under
			// test — the generic var alone, or a signal-specific var alongside it.
			for _, k := range endpointVars {
				t.Setenv(k, "")
			}
			t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", rec.URL)
			switch gate {
			case "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT":
				t.Setenv(gate, rec.URL+"/v1/traces")
			case "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT":
				t.Setenv(gate, rec.URL+"/v1/metrics")
			}

			shutdown, err := Setup(context.Background(), "v-test")
			if err != nil {
				t.Fatalf("Setup(%s): %v", gate, err)
			}
			if shutdown == nil {
				t.Fatal("Setup returned a nil shutdown func")
			}

			// The SDK is live: a span from the global tracer records (it did not with no
			// endpoint configured), and a counter is registered on the real meter.
			_, span := Tracer().Start(context.Background(), "stage.plan")
			if !span.IsRecording() {
				t.Error("span is not recording although a telemetry endpoint is configured")
			}
			span.End()

			counter, err := otel.Meter("alethia-runner").Int64Counter("alethia.gate_block")
			if err != nil {
				t.Fatalf("Int64Counter: %v", err)
			}
			counter.Add(context.Background(), 1)

			// Shutdown drains both pipelines — the flush the runner relies on at SIGTERM.
			if err := shutdown(context.Background()); err != nil {
				t.Fatalf("shutdown: %v", err)
			}
			if !rec.hit("/v1/traces") {
				t.Error("shutdown did not flush the buffered span to the collector")
			}
			if !rec.hit("/v1/metrics") {
				t.Error("shutdown did not flush the recorded metric to the collector")
			}
		})
	}
}

// TestSetup_RegistersW3CPropagator asserts Setup installs the W3C trace-context propagator,
// so a cross-process hop the runner makes carries the SAME traceparent the job was anchored
// to — the wire half of the console↔runner JOIN.
func TestSetup_RegistersW3CPropagator(t *testing.T) {
	restoreGlobalTelemetry(t)
	rec := newOTLPRecorder(t)
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", rec.URL)
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "")

	shutdown, err := Setup(context.Background(), "v-test")
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	t.Cleanup(func() { _ = shutdown(context.Background()) })

	const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ContextFromTraceparent(context.Background(), traceparent), carrier)

	if got := carrier.Get("traceparent"); got != traceparent {
		t.Errorf("injected traceparent = %q, want %q", got, traceparent)
	}
}
