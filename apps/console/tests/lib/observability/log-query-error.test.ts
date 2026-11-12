// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// A failed database query is logged without its bound parameter values. drizzle-orm's
// `DrizzleQueryError` puts them in its `message` (`Failed query: <sql>\nparams: <values>`), and V8
// repeats the message in `stack`; the console logger's `err` serializer (lib/observability/log.ts)
// writes `Failed query: <sql>` in both, on the pino line and on the OTel log bridge, and keeps the
// driver error under `cause`.

import { type LogRecord, logs } from "@opentelemetry/api-logs";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@/lib/observability/log";

/** A multi-line SQL text, as drizzle builds for a longer query. */
const SQL = 'select "id", "email"\nfrom "users"\nwhere "email" = $1 and "token" = $2';
/** The bound parameter values; neither may appear anywhere in a log line. */
const PARAMS = ["a@b.c", "secret-param"];

/** Builds a driver error like postgres.js raises for a unique violation. */
function driverError(): Error {
	return Object.assign(new Error("duplicate key value violates unique constraint"), {
		code: "23505",
	});
}

/** Builds a real drizzle-orm query error over SQL and PARAMS, caused by a driver error. */
function queryError(): DrizzleQueryError {
	return new DrizzleQueryError(SQL, PARAMS, driverError());
}

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

/** Asserts that no parameter value appears in `text`. */
function expectNoParams(text: string): void {
	for (const p of PARAMS) expect(text).not.toContain(p);
	expect(text).not.toContain("params:");
}

describe("a logged DrizzleQueryError", () => {
	it("is built by drizzle-orm with the parameter values in its message and stack", () => {
		// The premise: if drizzle-orm stopped writing them, the tests below would pass vacuously.
		const e = queryError();
		expect(e.message).toBe(`Failed query: ${SQL}\nparams: ${PARAMS.join(",")}`);
		expect(e.stack).toContain("secret-param");
	});

	it("writes the SQL text and the cause's code, and no parameter value, on the pino line", () => {
		const { log, lines } = collectLogger();
		log.error("query failed", { err: queryError() });
		const err = errOf(lines[0]);
		expectNoParams(JSON.stringify(lines[0]));
		expect(err).toMatchObject({
			type: "DrizzleQueryError",
			message: `Failed query: ${SQL}`,
			cause: {
				type: "Error",
				message: "duplicate key value violates unique constraint",
				code: "23505",
			},
		});
		// The stack is kept, with the message line rewritten rather than the frames dropped.
		expect(err).toHaveProperty("stack");
		const stack = typeof err === "object" && err !== null && "stack" in err ? err.stack : "";
		expect(String(stack)).toContain(`Failed query: ${SQL}`);
		expect(String(stack)).toMatch(/\n\s+at /);
	});

	it("is scrubbed when it is the cause of another error", () => {
		const { log, lines } = collectLogger();
		log.error("action failed", { err: new Error("could not save", { cause: queryError() }) });
		expectNoParams(JSON.stringify(lines[0]));
		expect(errOf(lines[0])).toMatchObject({
			message: "could not save",
			cause: { message: `Failed query: ${SQL}`, cause: { code: "23505" } },
		});
	});

	it("is recognised by its query/params shape, so a second copy of drizzle-orm is matched too", () => {
		/** Stands in for `DrizzleQueryError` loaded from a second copy of the package. */
		class OtherCopyQueryError extends Error {
			query: string;
			params: unknown[];
			/** Builds the error the way drizzle-orm 0.45 does. */
			constructor(query: string, params: unknown[], cause?: unknown) {
				super(`Failed query: ${query}\nparams: ${params}`, { cause });
				this.query = query;
				this.params = params;
			}
		}
		const { log, lines } = collectLogger();
		log.error("query failed", { err: new OtherCopyQueryError(SQL, PARAMS, driverError()) });
		expectNoParams(JSON.stringify(lines[0]));
		expect(errOf(lines[0])).toMatchObject({
			message: `Failed query: ${SQL}`,
			cause: { code: "23505" },
		});
	});

	it("drops the stack when the message was changed after the error was built", () => {
		const e = queryError();
		// V8 formats the stack on first read, so read it before the change to fix the old message in it.
		expect(e.stack).toContain("secret-param");
		e.message = "rewritten";
		const { log, lines } = collectLogger();
		log.error("query failed", { err: e });
		expectNoParams(JSON.stringify(lines[0]));
		expect(errOf(lines[0])).not.toHaveProperty("stack");
	});

	it("leaves a plain Error whose message contains 'params:' unchanged", () => {
		const plain = new Error(`Failed query: ${SQL}\nparams: ${PARAMS.join(",")}`);
		const { log, lines } = collectLogger();
		log.error("plain", { err: plain });
		expect(errOf(lines[0])).toMatchObject({ type: "Error", message: plain.message, stack: plain.stack });
	});

	it("leaves an error with a query string but no params array unchanged", () => {
		const searchError = Object.assign(new Error("search backend timed out"), { query: "status:open" });
		const { log, lines } = collectLogger();
		log.error("search failed", { err: searchError });
		expect(errOf(lines[0])).toMatchObject({ message: "search backend timed out", stack: searchError.stack });
	});
});

describe("the OTel log bridge, for a DrizzleQueryError", () => {
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

	it("writes the SQL text and no parameter value in any attribute", () => {
		const records = captureOtel();
		const { log } = collectLogger();
		log.error("query failed", { err: queryError() });
		expect(records).toHaveLength(1);
		const attrs = records[0]?.attributes ?? {};
		expectNoParams(JSON.stringify(attrs));
		expect(attrs["error.type"]).toBe("DrizzleQueryError");
		expect(attrs["error.message"]).toBe(`Failed query: ${SQL}`);
		expect(String(attrs["error.stack"])).toContain(`Failed query: ${SQL}`);
	});

	it("leaves a plain Error whose message contains 'params:' unchanged", () => {
		const records = captureOtel();
		const { log } = collectLogger();
		const plain = new Error("bad input\nparams: x=1");
		log.error("plain", { err: plain });
		const attrs = records[0]?.attributes ?? {};
		expect(attrs["error.message"]).toBe(plain.message);
		expect(attrs["error.stack"]).toBe(plain.stack);
	});
});
