// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// A log line that leaves the process through the OTel logs bridge (lib/observability/log.ts) carries
// no email address: the body, `error.message`, `error.stack` and every string attribute have their
// address-shaped substrings replaced by `[email]`. The pino line on stdout — the operator's own log —
// keeps them. The matcher is a linear scan, so a megabyte of address-free text costs milliseconds.

import { type LogRecord, logs } from "@opentelemetry/api-logs";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@/lib/observability/log";

/** Collects newline-delimited JSON log lines written to a pino destination stream. */
function collectLogger() {
	const lines: string[] = [];
	const destination = {
		write(chunk: string) {
			for (const line of chunk.split("\n")) {
				if (line.trim()) lines.push(line);
			}
		},
	};
	return { log: createLogger({ level: "info", destination }), lines };
}

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

/** An email provider's send error, quoting the recipient the way a provider SDK does. */
class ProviderSendError extends Error {
	code: string;
	statusCode: number;
	constructor(message: string) {
		super(message);
		this.name = "ProviderSendError";
		this.code = "validation_error";
		this.statusCode = 422;
	}
}

/** Bridges one line with `msg` as its body and returns the body. */
function bridgedBody(msg: string): unknown {
	const records = captureOtel();
	const { log } = collectLogger();
	log.info(msg);
	return records[0]?.body;
}

afterEach(() => {
	logs.disable();
});

describe("the OTel log bridge, for a line that quotes an email address", () => {
	it("bridges a provider send error with no recipient address in any field", () => {
		const records = captureOtel();
		const { log, lines } = collectLogger();
		const err = new ProviderSendError(
			"Invalid `to` field. The email address jane.doe+billing@example.co.uk is not verified.",
		);
		log.error("[auth] magic-link code email to jane.doe+billing@example.co.uk failed", { err });

		expect(records).toHaveLength(1);
		const record = records[0];
		const attrs = record?.attributes ?? {};
		const bridged = JSON.stringify({ body: record?.body, attrs });
		expect(bridged).not.toContain("jane.doe");
		expect(bridged).not.toContain("example.co.uk");
		expect(attrs["error.message"]).toBe(
			"Invalid `to` field. The email address [email] is not verified.",
		);
		expect(attrs["error.stack"]).toMatch(
			/^ProviderSendError: Invalid `to` field\. The email address \[email\] is not verified\.\n\s+at /,
		);
		expect(attrs["error.code"]).toBe("validation_error");
		expect(attrs["error.type"]).toBe("ProviderSendError");
		expect(record?.body).toBe("[auth] magic-link code email to [email] failed");

		// stdout is the operator's own log: the address stays there, for whoever debugs the send.
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("jane.doe+billing@example.co.uk");
	});

	it("redacts a string err, a string field and a JSON-encoded field", () => {
		const records = captureOtel();
		const { log } = collectLogger();
		log.warn("send failed", { err: "rejected: ops@acme.io", recipient: "ops@acme.io" });
		log.warn("send failed", { to: ["a@b.dev", "c@d.dev"] });
		expect(records[0]?.attributes?.["error.message"]).toBe("rejected: [email]");
		expect(records[0]?.attributes?.recipient).toBe("[email]");
		expect(records[1]?.attributes?.to).toBe('["[email]","[email]"]');
	});

	it("leaves a line with no address as it was, including numbers and booleans", () => {
		const records = captureOtel();
		const { log } = collectLogger();
		log.info("job claimed", { job_id: "j-1", attempt: 2, retry: false });
		expect(records[0]?.body).toBe("job claimed");
		expect(records[0]?.attributes).toEqual({ job_id: "j-1", attempt: 2, retry: false });
	});
});

describe("what the bridge treats as an email address", () => {
	it.each([
		["mail bob@example.com now", "mail [email] now"],
		["to: Bob <bob.smith@mail.example.org>", "to: Bob <[email]>"],
		["two: a@x.io, b@y.io.", "two: [email], [email]."],
		["o'brien@example.ie", "[email]"],
		["UPPER@EXAMPLE.COM", "[email]"],
		["user@bücher.de", "[email]"],
		["jörg@example.de", "[email]"],
		["user@example.xn--p1ai", "[email]"],
		["to=user%40example.com&x=1", "to=[email]&x=1"],
		["git@github.com:org/repo", "[email]:org/repo"],
	])("redacts %j", (input, expected) => {
		expect(bridgedBody(input)).toBe(expected);
	});

	it.each([
		["at node_modules/.pnpm/pino@9.1.0/node_modules/pino/lib/proto.js:1:1"],
		["@opentelemetry/api-logs"],
		["user@localhost"],
		["a lone @ sign"],
		["trailing@"],
		["host@1.2.3.4"],
		["width=100%40px"],
	])("leaves %j", (input) => {
		expect(bridgedBody(input)).toBe(input);
	});
});

describe("the email matcher's cost", () => {
	it("bridges a 1 MB address-free run of local-part characters in linear time", () => {
		const records = captureOtel();
		const { log } = collectLogger();
		const blob = "a".repeat(1024 * 1024);
		// A run of local-part characters ending in `@` with no domain: the input that makes a
		// `[\w.]+@…` regex quadratic, as it restarts the local-part scan at each of a million offsets.
		const hostile = `${blob}@`;
		const t0 = performance.now();
		log.error(hostile, { err: new Error(hostile) });
		log.error(`${"a@".repeat(512 * 1024)}`);
		// Many literal `@` and one encoded marker at the very end: each kind is searched for once.
		log.error(`${"a@".repeat(256 * 1024)}x%40`);
		const elapsed = performance.now() - t0;
		expect(records[0]?.body).toBe(hostile);
		expect(elapsed).toBeLessThan(1000);
	});

	it("redacts an address at the end of 1 MB of text", () => {
		const blob = `${"x".repeat(1024 * 1024)} reply to ops@example.com`;
		expect(bridgedBody(blob)).toBe(`${"x".repeat(1024 * 1024)} reply to [email]`);
	});
});
