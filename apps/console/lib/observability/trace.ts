// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { toError } from "@/lib/errors";
import { randomBytes } from "node:crypto";
import {
	type Attributes,
	type Context,
	context,
	type Span,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";

/**
 * Mints a fresh W3C `traceparent` (version 00, sampled): a random 16-byte
 * trace-id + 8-byte span-id, formatted `00-<32hex>-<16hex>-01`. Stamped on a job
 * at enqueue so the console → runner hops share one trace-id and their spans/logs
 * correlate. See https://www.w3.org/TR/trace-context/#traceparent-header.
 */
export function newTraceparent(): string {
	const traceId = randomBytes(16).toString("hex"); // 32 hex chars
	const spanId = randomBytes(8).toString("hex"); // 16 hex chars
	return `00-${traceId}-${spanId}-01`;
}

/**
 * Extracts the 32-hex trace-id (the middle segment) from a `traceparent`, or
 * `null` if the string isn't a well-formed version-00 traceparent. Used to attach
 * `trace_id` to structured logs.
 */
export function traceIdFromTraceparent(
	traceparent: string | null | undefined,
): string | null {
	if (!traceparent) return null;
	const m = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(traceparent);
	return m ? m[1] : null;
}

/** The console's OTel tracer (no-op until an OTLP endpoint is configured). */
export function getTracer() {
	return trace.getTracer("alethia-console");
}

/**
 * Builds an OTel parent Context anchored to a job's `traceparent`, so a console span
 * started within it shares the job's trace-id and is a child of the enqueue root. This
 * is the console↔runner JOIN: the runner extracts the SAME traceparent, so both sides'
 * spans land in one trace. Falls back to the active context for a malformed/absent
 * traceparent (the span then starts a fresh trace rather than throwing).
 */
export function parentContextFromTraceparent(
	traceparent: string | null | undefined,
): Context {
	const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(
		traceparent ?? "",
	);
	if (!m) return context.active();
	return trace.setSpanContext(context.active(), {
		traceId: m[1],
		spanId: m[2],
		traceFlags: Number.parseInt(m[3], 16),
		isRemote: true,
	});
}

/**
 * Runs `fn` inside a span anchored to the job's `traceparent` (so the span joins the
 * distributed trace), ending the span and recording an exception on throw. A pure
 * pass-through when the tracer is no-op (endpoint unset): the span is the API's no-op
 * span, so there is no measurable cost and nothing is exported. The started span is
 * passed to `fn` for optional extra attributes.
 */
export async function withJobSpan<T>(
	name: string,
	traceparent: string | null | undefined,
	attributes: Attributes,
	fn: (span: Span) => Promise<T> | T,
): Promise<T> {
	const parent = parentContextFromTraceparent(traceparent);
	const span = getTracer().startSpan(name, { attributes }, parent);
	try {
		const out = await context.with(
			trace.setSpan(parent, span),
			() => fn(span),
		);
		span.setStatus({ code: SpanStatusCode.OK });
		return out;
	} catch (err) {
		span.recordException(toError(err));
		span.setStatus({ code: SpanStatusCode.ERROR });
		throw err;
	} finally {
		span.end();
	}
}

/**
 * Emits a single marker span anchored to the job's `traceparent` — the console's
 * participation in the distributed trace at a lifecycle point (claim / callback). A
 * no-op when the tracer is no-op. `startTime`/`endTime` bound its duration (default:
 * an instantaneous mark at now).
 */
export function markJobSpan(
	name: string,
	traceparent: string | null | undefined,
	attributes: Attributes,
	bounds?: { startTime?: Date; endTime?: Date },
): void {
	const parent = parentContextFromTraceparent(traceparent);
	const span = getTracer().startSpan(
		name,
		{ attributes, startTime: bounds?.startTime },
		parent,
	);
	span.end(bounds?.endTime);
}
