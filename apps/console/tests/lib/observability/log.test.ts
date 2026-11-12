// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The console logger's `err` serializer (lib/observability/log.ts) emits only the documented fields:
// `type`, `message`, `stack`, plus `code` / `status` / `statusCode` when they are primitives, recursing
// into `cause` and `errors` (`aggregateErrors` for an AggregateError). Every other enumerable property
// of an error stays out of the line, on both the pino line and the OTel log bridge.

import { type LogRecord, logs } from "@opentelemetry/api-logs";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@/lib/observability/log";

/** The keys a serialized error node may carry. */
const ALLOWED = new Set([
	"type",
	"message",
	"stack",
	"code",
	"status",
	"statusCode",
	"cause",
	"errors",
	"aggregateErrors",
]);

/** Collects newline-delimited JSON log lines written to a pino destination stream. */
function collectLogger() {
	const lines: unknown[] = [];
	const destination = {
		write(chunk: string) {
			for (const line of chunk.split("\n")) {
				if (line.trim()) lines.push(JSON.parse(line));
			}
		},
	};
	return { log: createLogger({ level: "info", destination }), lines };
}

/** Returns the `err` field of a parsed log line, failing the test when the line has none. */
function errOf(line: unknown): unknown {
	if (typeof line !== "object" || line === null || !("err" in line)) {
		throw new Error("log line has no err field");
	}
	return line.err;
}

/** Walks a serialized error tree and returns every key found on any node, with its path. */
function keysOf(node: unknown, path = "err"): string[] {
	if (typeof node !== "object" || node === null) return [];
	if (Array.isArray(node)) return node.flatMap((n, i) => keysOf(n, `${path}[${i}]`));
	return Object.entries(node).flatMap(([k, v]) => [`${path}.${k}`, ...keysOf(v, `${path}.${k}`)]);
}

/** An error class that carries request and response data as enumerable fields. */
class ProviderCallError extends Error {
	requestBodyValues: unknown;
	responseHeaders: Record<string, string>;
	statusCode: number;
	code: string;
	/** Builds the error with the extra fields set. */
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ProviderCallError";
		this.requestBodyValues = { prompt: "the whole prompt", messages: [{ role: "user" }] };
		this.responseHeaders = { "set-cookie": "s=1" };
		this.statusCode = 429;
		this.code = "rate_limited";
	}
}

/** An error carrying an `errors` array, like a retry wrapper. */
class RetryWrapperError extends Error {
	errors: unknown[];
	lastAttempt: unknown;
	/** Builds the error over the attempts. */
	constructor(message: string, errors: unknown[]) {
		super(message);
		this.name = "RetryWrapperError";
		this.errors = errors;
		this.lastAttempt = { body: "attempt body" };
	}
}

/** Builds the error tree the tests log: extra fields, a nested cause, an errors array and a cycle. */
function buildTree() {
	const root = new ProviderCallError("outer", {
		cause: new ProviderCallError("inner"),
	});
	const cyclic = new ProviderCallError("cyclic");
	Object.assign(cyclic, { cause: cyclic });
	const wrapper = new RetryWrapperError("retries exhausted", [root, cyclic, "a plain string"]);
	return { root, cyclic, wrapper };
}

describe("the logger's err serializer", () => {
	it("writes only the allowed keys for every node of a nested error tree", () => {
		const { log, lines } = collectLogger();
		const { wrapper } = buildTree();
		log.error("model call failed", { err: wrapper });

		const err = errOf(lines[0]);
		const keys = keysOf(err);
		const disallowed = keys.filter((k) => {
			const last = k.split(".").pop() ?? "";
			return !ALLOWED.has(last.replace(/\[\d+\]$/, ""));
		});
		expect(disallowed).toEqual([]);
		const text = JSON.stringify(err);
		expect(text).not.toContain("the whole prompt");
		expect(text).not.toContain("set-cookie");
		expect(text).not.toContain("attempt body");

		expect(err).toMatchObject({
			type: "RetryWrapperError",
			message: "retries exhausted",
			errors: [
				{
					type: "ProviderCallError",
					message: "outer",
					code: "rate_limited",
					statusCode: 429,
					cause: { type: "ProviderCallError", message: "inner", statusCode: 429 },
				},
				{ type: "ProviderCallError", message: "cyclic", cause: "[Circular]" },
				"a plain string",
			],
		});
		expect(err).toHaveProperty("stack");
		expect(err).toHaveProperty("errors.0.stack");
	});

	it("writes an AggregateError's members under aggregateErrors", () => {
		const { log, lines } = collectLogger();
		log.error("batch failed", {
			err: new AggregateError([new ProviderCallError("one")], "batch"),
		});
		expect(errOf(lines[0])).toMatchObject({
			type: "AggregateError",
			message: "batch",
			aggregateErrors: [{ type: "ProviderCallError", message: "one" }],
		});
		expect(JSON.stringify(errOf(lines[0]))).not.toContain("the whole prompt");
	});

	it("stops following cause after a bounded depth", () => {
		const { log, lines } = collectLogger();
		let e = new Error("level 0");
		for (let i = 1; i <= 20; i++) e = new Error(`level ${i}`, { cause: e });
		log.error("deep", { err: e });
		expect(JSON.stringify(errOf(lines[0]))).toContain("[MaxDepth]");
	});

	it("writes exactly MAX_ERR_DEPTH (5) levels before the marker", () => {
		const { log, lines } = collectLogger();
		let e = new Error("level 0");
		for (let i = 1; i <= 20; i++) e = new Error(`level ${i}`, { cause: e });
		log.error("deep", { err: e });
		let node: unknown = errOf(lines[0]);
		let levels = 0;
		while (typeof node === "object" && node !== null && "cause" in node) {
			levels++;
			node = node.cause;
		}
		expect(levels).toBe(5);
		expect(node).toBe("[MaxDepth]");
	});

	it("keeps a primitive status", () => {
		const { log, lines } = collectLogger();
		log.error("upstream", { err: Object.assign(new Error("bad gateway"), { status: 503, body: "x" }) });
		expect(errOf(lines[0])).toMatchObject({ type: "Error", message: "bad gateway", status: 503 });
		expect(JSON.stringify(errOf(lines[0]))).not.toContain('"body"');
	});

	it("caps an errors array and marks how many entries it left out", () => {
		const { log, lines } = collectLogger();
		const many = Array.from({ length: 12 }, (_, i) => new Error(`attempt ${i}`));
		log.error("retries", { err: new RetryWrapperError("exhausted", many) });
		const err = errOf(lines[0]);
		const list = typeof err === "object" && err !== null && "errors" in err ? err.errors : undefined;
		expect(Array.isArray(list) ? list.length : -1).toBe(11);
		expect(Array.isArray(list) ? list[10] : undefined).toBe("[+2 more]");
	});

	it("writes a primitive as a string and a non-error object as its type and status fields only", () => {
		const { log, lines } = collectLogger();
		log.error("string thrown", { err: "boom" });
		log.error("number thrown", { err: 42 });
		log.error("object thrown", { err: { token: "secret-ish", nested: { a: 1 } } });
		/** A thrown non-error class instance. */
		class Thrown {
			token = "secret-ish";
			code = "E_OBJ";
			status = 503;
		}
		log.error("instance thrown", { err: new Thrown() });
		expect(errOf(lines[0])).toBe("boom");
		expect(errOf(lines[1])).toBe("42");
		expect(errOf(lines[2])).toEqual({ type: "Object" });
		expect(errOf(lines[3])).toEqual({ type: "Thrown", code: "E_OBJ", status: 503 });
	});
});

describe("the OTel log bridge", () => {
	afterEach(() => {
		logs.disable();
	});

	/** Registers a global LoggerProvider that records every emitted log record. */
	function captureOtel(): LogRecord[] {
		const records: LogRecord[] = [];
		logs.setGlobalLoggerProvider({
			getLogger: () => ({
				emit: (record: LogRecord) => {
					records.push(record);
				},
				enabled: () => true,
			}),
		});
		return records;
	}

	it("flattens err to type, message and stack, and never dumps the error object", () => {
		const records = captureOtel();
		const { log } = collectLogger();
		log.error("model call failed", { err: buildTree().root });
		expect(records).toHaveLength(1);
		const attrs = records[0]?.attributes ?? {};
		expect(attrs["error.type"]).toBe("ProviderCallError");
		expect(attrs["error.message"]).toBe("outer");
		expect(attrs["error.code"]).toBe("rate_limited");
		expect(typeof attrs["error.stack"]).toBe("string");
		expect(attrs.err).toBeUndefined();
		expect(JSON.stringify(attrs)).not.toContain("the whole prompt");
	});

	it("does not JSON-dump a non-error object passed as err", () => {
		const records = captureOtel();
		const { log } = collectLogger();
		log.error("object thrown", { err: { token: "secret-ish" } });
		const attrs = records[0]?.attributes ?? {};
		expect(attrs["error.type"]).toBe("Object");
		expect(JSON.stringify(attrs)).not.toContain("secret-ish");
	});

	it("writes a string err as error.message", () => {
		const records = captureOtel();
		const { log } = collectLogger();
		log.error("failed", { err: "boom" });
		const attrs = records[0]?.attributes ?? {};
		expect(attrs["error.message"]).toBe("boom");
		expect(attrs.err).toBeUndefined();
	});
});
