// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the observability substrate: the W3C traceparent minting/parsing and the
// structured pino logger (field carrying via child + level gating).

import { describe, expect, it } from "vitest";
import { createLogger } from "@/lib/observability/log";
import {
	newTraceparent,
	traceIdFromTraceparent,
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
});
