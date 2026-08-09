// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package obs is the runner's OpenTelemetry traces + metrics bootstrap — the SDK half of
// the telemetry layer (packages/core/telemetry is the API-only instrumentation the
// provisioner emits through). It is STRICTLY endpoint-gated, PER SIGNAL: a signal's
// pipeline is built only when that signal has an endpoint — its own
// OTEL_EXPORTER_OTLP_{TRACES,METRICS}_ENDPOINT, or the generic
// OTEL_EXPORTER_OTLP_ENDPOINT that stands in for both. A signal with no endpoint
// registers NOTHING, so its global tracer/meter stays the OTel API's built-in no-op — the
// provisioner's stage spans + the gate-block metric compile to no-ops that cost nothing
// and export nothing, and no exporter ever falls back to the SDK's default
// localhost:4318. Telemetry is never a hard dependency of a provision and a collector
// outage can never block one (spans batch with a bounded, drop-on-full queue; metrics
// export on an interval).
package obs

import (
	"context"
	"encoding/hex"
	"os"
	"regexp"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.34.0"
	"go.opentelemetry.io/otel/trace"
)

// serviceName is the resource attribute spans/metrics from the runner carry (NOT a
// metric label — service identity belongs on the resource).
const serviceName = "alethia-runner"

// tpRe matches a W3C version-00 traceparent, capturing trace-id + span-id.
var tpRe = regexp.MustCompile(`^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$`)

// Setup boots the trace and/or metric SDK and returns a shutdown func — but ONLY for the
// signals that have an endpoint. Each signal is gated on its OWN endpoint: per the OTLP
// spec the signal-specific OTEL_EXPORTER_OTLP_{TRACES,METRICS}_ENDPOINT wins and the
// generic OTEL_EXPORTER_OTLP_ENDPOINT is the fallback for both, so configuring traces
// alone must NOT boot a metric pipeline (it would have no endpoint of its own and the SDK
// would ship to its default localhost:4318 every interval, forever). Neither signal
// configured ⇒ a complete no-op: no provider is registered and the shutdown is a no-op.
// The returned shutdown tears down only what was actually started. Never fatal: an
// exporter-construction error is returned for the caller to log and continue without
// telemetry (a provision must never fail because a collector is misconfigured).
func Setup(ctx context.Context, version string) (func(context.Context) error, error) {
	noop := func(context.Context) error { return nil }
	generic := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	tracesEnabled := os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") != "" || generic != ""
	metricsEnabled := os.Getenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT") != "" || generic != ""
	if !tracesEnabled && !metricsEnabled {
		return noop, nil
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(serviceName),
			semconv.ServiceVersion(version),
		),
	)
	if err != nil {
		return noop, err
	}

	// Only the pipelines actually started get a teardown; shutdown closes over the slice,
	// so it drains exactly what this call registered and nothing else.
	var stops []func(context.Context) error
	shutdown := func(c context.Context) error {
		var firstErr error
		for _, stop := range stops {
			if err := stop(c); err != nil && firstErr == nil {
				firstErr = err
			}
		}
		return firstErr
	}

	if tracesEnabled {
		// Traces: endpoint/headers come from the standard OTEL_EXPORTER_OTLP_* env.
		// WithBatcher installs a batch processor with a bounded queue that DROPS spans when
		// full — never blocking the provisioning path on a slow/absent collector.
		traceExp, terr := otlptracehttp.New(ctx)
		if terr != nil {
			return noop, terr
		}
		tp := sdktrace.NewTracerProvider(
			sdktrace.WithBatcher(traceExp,
				sdktrace.WithMaxQueueSize(2048),
				sdktrace.WithMaxExportBatchSize(512),
				sdktrace.WithBatchTimeout(5*time.Second),
			),
			sdktrace.WithResource(res),
		)
		otel.SetTracerProvider(tp)
		// Register the W3C trace-context propagator so any future cross-process hop speaks
		// the same traceparent the console minted.
		otel.SetTextMapPropagator(propagation.TraceContext{})
		stops = append(stops, tp.Shutdown)
	}

	if metricsEnabled {
		// Metrics: a periodic reader batches + exports on an interval; an export failure is
		// retried next interval and never blocks the caller.
		metricExp, merr := otlpmetrichttp.New(ctx)
		if merr != nil {
			_ = shutdown(ctx)
			return noop, merr
		}
		mp := sdkmetric.NewMeterProvider(
			sdkmetric.WithResource(res),
			sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExp,
				sdkmetric.WithInterval(15*time.Second))),
		)
		otel.SetMeterProvider(mp)
		stops = append(stops, mp.Shutdown)
	}

	return shutdown, nil
}

// Tracer returns the runner's tracer (the global tracer; no-op until Setup registers a
// provider).
func Tracer() trace.Tracer { return otel.Tracer("alethia-runner") }

// ContextFromTraceparent anchors ctx to the job's W3C traceparent by installing it as
// the REMOTE parent span context — so a span the runner starts from this ctx shares the
// console's trace-id and nests under the enqueue root. This is the runner half of the
// console↔runner trace JOIN. Returns ctx unchanged for a malformed/absent traceparent.
// Deterministic and provider-independent (a direct parse, not the global propagator), so
// the trace-id inheritance holds — and is testable — regardless of whether the SDK is on.
func ContextFromTraceparent(ctx context.Context, traceparent string) context.Context {
	sc, ok := SpanContextFromTraceparent(traceparent)
	if !ok {
		return ctx
	}
	return trace.ContextWithRemoteSpanContext(ctx, sc)
}

// SpanContextFromTraceparent parses a W3C version-00 traceparent into a sampled, remote
// trace.SpanContext. ok is false for a malformed/empty traceparent.
func SpanContextFromTraceparent(traceparent string) (trace.SpanContext, bool) {
	m := tpRe.FindStringSubmatch(traceparent)
	if m == nil {
		return trace.SpanContext{}, false
	}
	var tid trace.TraceID
	var sid trace.SpanID
	if _, err := hex.Decode(tid[:], []byte(m[1])); err != nil {
		return trace.SpanContext{}, false
	}
	if _, err := hex.Decode(sid[:], []byte(m[2])); err != nil {
		return trace.SpanContext{}, false
	}
	return trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    tid,
		SpanID:     sid,
		TraceFlags: trace.FlagsSampled,
		Remote:     true,
	}), true
}
