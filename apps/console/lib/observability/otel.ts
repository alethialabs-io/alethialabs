// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// OpenTelemetry traces + metrics bootstrap for the console. This is the additive
// telemetry layer on top of the structured-logging + W3C-traceparent substrate:
// it exports the SPANS + METRICS that make the enqueue→claim→…→callback trace and
// the fleet/provision metric set visible to a self-hosted collector.
//
// It is STRICTLY endpoint-gated (exactly like the Umami / OpenReplay analytics
// gating): when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset we never register a provider,
// so `trace.getTracer()` / `metrics.getMeter()` keep returning the API's built-in
// no-op — spans/metrics compile to nothing, cost nothing, and drop nothing as an
// error. OTel is NEVER a hard dependency and NEVER backpressures a provision.

import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
	BatchSpanProcessor,
	NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import {
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { log } from "@/lib/observability/log";

const olog = log.child({ component: "otel" });

/** The service name spans/metrics are tagged with (resource attribute, not a metric label). */
export const OTEL_SERVICE_NAME = "alethia-console";

let tracerProvider: NodeTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;

/**
 * Boots the OTel Node trace + metric SDKs, but ONLY when an OTLP endpoint is
 * configured. Unset ⇒ a complete no-op (no providers registered → the global
 * tracer/meter stay no-op). Idempotent, and never throws: any setup failure is
 * logged and swallowed so a bad collector URL can't crash the console at startup.
 * Returns true iff a provider was registered.
 */
export function startOtel(): boolean {
	if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return false;
	if (tracerProvider) return true; // already started
	try {
		const resource = resourceFromAttributes({
			[ATTR_SERVICE_NAME]: OTEL_SERVICE_NAME,
			[ATTR_SERVICE_VERSION]: process.env.ALETHIA_VERSION ?? "dev",
		});

		// Traces: a BATCHED span processor with a bounded queue. When the queue is full
		// (e.g. the collector is down) spans are DROPPED, never buffered unboundedly and
		// never blocking the request path — a provision must never wait on telemetry.
		const traceExporter = new OTLPTraceExporter();
		tracerProvider = new NodeTracerProvider({
			resource,
			spanProcessors: [
				new BatchSpanProcessor(traceExporter, {
					maxQueueSize: 2048, // drop-on-full past this
					maxExportBatchSize: 512,
					scheduledDelayMillis: 5000,
					exportTimeoutMillis: 30000,
				}),
			],
		});
		// register() installs the global tracer provider, the W3C trace-context
		// propagator, and an AsyncLocalStorage context manager. It does NOT patch http/pg
		// (we register no auto-instrumentations), so the existing setInterval loops are
		// untouched — this only adds a context manager they don't use.
		tracerProvider.register();

		// Metrics: a periodic reader batches + exports on an interval. An export failure is
		// logged by the SDK and the next interval simply overwrites — a collector outage can
		// never block or backpressure a provision.
		const metricExporter = new OTLPMetricExporter();
		meterProvider = new MeterProvider({
			resource,
			readers: [
				new PeriodicExportingMetricReader({
					exporter: metricExporter,
					exportIntervalMillis: 15000,
				}),
			],
		});
		metrics.setGlobalMeterProvider(meterProvider);

		olog.info("OpenTelemetry traces + metrics enabled", {
			endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
		});
		return true;
	} catch (err) {
		olog.error("OpenTelemetry setup failed; continuing without telemetry", {
			err,
		});
		return false;
	}
}

/**
 * Flushes + shuts down the OTel providers (used by tests and graceful shutdown).
 * A no-op when telemetry was never started.
 */
export async function shutdownOtel(): Promise<void> {
	await Promise.allSettled([
		tracerProvider?.shutdown(),
		meterProvider?.shutdown(),
	]);
	tracerProvider = undefined;
	meterProvider = undefined;
}
