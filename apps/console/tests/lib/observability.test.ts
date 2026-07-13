// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the observability substrate: the W3C traceparent minting/parsing and the
// structured pino logger (field carrying via child + level gating).

import {
	InMemorySpanExporter,
	NodeTracerProvider,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@/lib/observability/log";
import {
	outcomeFromStatus,
	recordClaimLatency,
	recordFleetSize,
	recordProvision,
	recordQueueDepth,
	recordScalerAction,
} from "@/lib/observability/metrics";
import {
	markJobSpan,
	newTraceparent,
	traceIdFromTraceparent,
	withJobSpan,
} from "@/lib/observability/trace";

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

describe("newTraceparent", () => {
	it("mints a well-formed version-00 sampled traceparent", () => {
		expect(newTraceparent()).toMatch(TRACEPARENT_RE);
	});

	it("mints a distinct trace-id each call", () => {
		const a = newTraceparent();
		const b = newTraceparent();
		expect(a).not.toEqual(b);
		expect(traceIdFromTraceparent(a)).not.toEqual(traceIdFromTraceparent(b));
	});
});

describe("traceIdFromTraceparent", () => {
	it("extracts the 32-hex trace-id from a valid traceparent", () => {
		const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
		expect(traceIdFromTraceparent(tp)).toBe(
			"0af7651916cd43dd8448eb211c80319c",
		);
	});

	it("returns null for malformed / empty input", () => {
		expect(traceIdFromTraceparent(null)).toBeNull();
		expect(traceIdFromTraceparent(undefined)).toBeNull();
		expect(traceIdFromTraceparent("not-a-traceparent")).toBeNull();
		expect(
			traceIdFromTraceparent("00-short-b7ad6b7169203331-01"),
		).toBeNull();
	});

	it("round-trips a minted traceparent", () => {
		const tp = newTraceparent();
		const id = traceIdFromTraceparent(tp);
		expect(id).not.toBeNull();
		expect(tp).toContain(id as string);
	});
});

/** Collects newline-delimited JSON log lines written to a pino destination stream. */
function collectLogger(level?: string) {
	const lines: Record<string, unknown>[] = [];
	const destination = {
		write(chunk: string) {
			for (const line of chunk.split("\n")) {
				if (line.trim()) lines.push(JSON.parse(line));
			}
		},
	};
	return { log: createLogger({ level, destination }), lines };
}

describe("createLogger", () => {
	it("emits structured JSON with the message and fields", () => {
		const { log, lines } = collectLogger("info");
		log.info("claimed job", { job_id: "j-1", trace_id: "t-1" });
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			msg: "claimed job",
			level: "info",
			job_id: "j-1",
			trace_id: "t-1",
		});
	});

	it("stamps child bindings on every subsequent line", () => {
		const { log, lines } = collectLogger("info");
		const child = log.child({ component: "fleet", runner_id: "r-9" });
		child.warn("reconcile failed", { provider: "aws" });
		expect(lines[0]).toMatchObject({
			component: "fleet",
			runner_id: "r-9",
			provider: "aws",
			msg: "reconcile failed",
			level: "warn",
		});
	});

	it("gates below the configured level", () => {
		const { log, lines } = collectLogger("info");
		log.debug("noisy detail");
		expect(lines).toHaveLength(0);
		log.info("kept");
		expect(lines).toHaveLength(1);
	});

	// Regression: the prod deploy emits ALETHIA_LOG_LEVEL even when unset → "". An empty/blank/unknown
	// level made pino throw at construction ("default level: must be included in custom levels"), and
	// since createLogger runs at module load (instrumentation.ts) that crashed the whole server (every
	// route 500). createLogger must normalize a bad level to "info" instead of throwing.
	it.each(["", "   ", "verbose", "INFO"])(
		"does not throw on a blank/unknown level (%j) — falls back to info",
		(level) => {
			expect(() => createLogger({ level })).not.toThrow();
			const { log, lines } = collectLogger(level);
			log.info("kept");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toMatchObject({ level: "info", msg: "kept" });
		},
	);
});

// The OTLP endpoint is unset in the test env, so startOtel() is never called → the
// global tracer + meter stay the OTel API's built-in no-op. These assert the whole
// telemetry surface is a SAFE no-op in that state: no throw, no error, no side effect
// (exactly the Umami/OpenReplay analytics-gating contract — telemetry is never a hard
// dependency and never backpressures a provision).
describe("telemetry is a safe no-op when no OTLP endpoint is configured", () => {
	it("metric record helpers do not throw with the no-op global meter", () => {
		expect(() => {
			recordQueueDepth("aws", 3);
			recordFleetSize("gcp", 2);
			recordScalerAction("hetzner", "create");
			recordScalerAction(null, "drain");
			recordClaimLatency("azure", 4.2);
			recordClaimLatency("aws", -1); // clock-skew guard: silently ignored
			recordProvision({
				provider: "aws",
				jobType: "DEPLOY",
				outcome: "success",
				seconds: 120,
			});
			recordProvision({
				provider: null,
				jobType: "PLAN",
				outcome: "fail",
				seconds: 5,
			});
		}).not.toThrow();
	});

	it("span helpers do not throw and pass values through with the no-op tracer", async () => {
		const tp = newTraceparent();
		expect(() =>
			markJobSpan("console.job.claim", tp, { provider: "aws" }),
		).not.toThrow();
		// A malformed traceparent must degrade, not throw.
		expect(() => markJobSpan("x", "not-a-traceparent", {})).not.toThrow();

		const out = await withJobSpan("console.job.callback", tp, {}, () => 42);
		expect(out).toBe(42);
		// The wrapper re-throws the inner error (and ends the span) — must not swallow.
		await expect(
			withJobSpan("boom", tp, {}, () => {
				throw new Error("inner");
			}),
		).rejects.toThrow("inner");
	});

	it("maps terminal statuses to the low-cardinality outcome dimension", () => {
		expect(outcomeFromStatus("SUCCESS")).toBe("success");
		expect(outcomeFromStatus("CANCELLED")).toBe("cancel");
		expect(outcomeFromStatus("FAILED")).toBe("fail");
	});
});

// Proves the console↔runner JOIN mechanism on the TS side: a console span started from a
// job's traceparent lands in the SAME trace-id as the traceparent. (The Go side asserts
// the runner half — see slog_test.go / obs.) Registers a real in-memory provider so a
// span is actually produced, then resets the global tracer.
describe("console spans join the trace carried by a job's traceparent", () => {
	afterEach(() => {
		trace.disable(); // reset the global tracer provider between tests
	});

	it("a span from a traceparent inherits that traceparent's trace-id", () => {
		const exporter = new InMemorySpanExporter();
		const provider = new NodeTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		provider.register();

		const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
		markJobSpan("console.job.claim", tp, { provider: "aws" });

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		// The span's trace-id MUST equal the traceparent's trace-id (the join), and its
		// parent MUST be the traceparent's span-id (child of the enqueue root).
		expect(spans[0].spanContext().traceId).toBe(
			"0af7651916cd43dd8448eb211c80319c",
		);
		expect(spans[0].parentSpanContext?.spanId).toBe("b7ad6b7169203331");
		expect(spans[0].name).toBe("console.job.claim");
		expect(spans[0].attributes.provider).toBe("aws");
	});
});
