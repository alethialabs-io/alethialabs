// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// `onRequestError` (instrumentation.ts) logs an uncaught request error under `err`, so it goes
// through the logger's `err` serializer (lib/observability/log.ts) rather than being written as a
// raw `stack` string. An expected request error (a redirect, a not-found, the "Unauthorized"
// sentinel) is still logged quietly at debug, without the error. The logger here is the real one,
// writing to a captured stream, so the assertions read the line.

import { DrizzleQueryError } from "drizzle-orm/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every JSON line the hook's logger wrote, parsed. */
const lines = vi.hoisted((): unknown[] => []);

vi.mock("@/lib/observability/log", async () => {
	const actual = await vi.importActual<typeof import("@/lib/observability/log")>(
		"@/lib/observability/log",
	);
	const destination = {
		/** Parses each newline-delimited JSON line pino writes into `lines`. */
		write(chunk: string) {
			for (const line of chunk.split("\n")) {
				if (line.trim()) {
					const parsed: unknown = JSON.parse(line);
					lines.push(parsed);
				}
			}
		},
	};
	return { ...actual, log: actual.createLogger({ level: "debug", destination }) };
});

import { onRequestError } from "@/instrumentation";

/** A multi-line SQL text, as drizzle builds for a longer query. */
const SQL = 'select "id"\nfrom "users"\nwhere "email" = $1';
/** The bound parameter values of the failed query. */
const PARAMS = ["a@b.c"];
/** A value planted on the error as an enumerable field; the serializer never writes it. */
const PLANTED = "planted-enumerable-field-value";

/** Builds a real drizzle-orm query error, caused by a driver error, with a planted field. */
function queryError(): DrizzleQueryError {
	const cause = Object.assign(new Error("duplicate key value violates unique constraint"), {
		code: "23505",
	});
	return Object.assign(new DrizzleQueryError(SQL, PARAMS, cause), {
		connection: PLANTED,
		digest: "4242",
	});
}

/** Returns the one captured line whose `msg` is `msg`, failing the test when there is none. */
function lineWithMsg(msg: string): unknown {
	const found = lines.find(
		(l) => typeof l === "object" && l !== null && "msg" in l && l.msg === msg,
	);
	if (found === undefined) throw new Error(`no log line "${msg}"`);
	return found;
}

beforeEach(() => {
	lines.length = 0;
	// Off the Node runtime the hook only logs: the analytics and Sentry forwards are skipped.
	vi.stubEnv("NEXT_RUNTIME", "");
});

describe("onRequestError — the logged line", () => {
	it("writes an uncaught error under err, as the serializer writes it, with the request context", async () => {
		await onRequestError(
			queryError(),
			{ path: "/acme/projects", method: "POST" },
			{ routePath: "/[org]/projects", routeType: "action" },
		);
		const line = lineWithMsg("uncaught request error");
		expect(JSON.stringify(line)).not.toContain(PLANTED);
		for (const p of PARAMS) expect(JSON.stringify(line)).not.toContain(p);
		expect(JSON.stringify(line)).not.toContain("params:");
		expect(line).toMatchObject({
			component: "onRequestError",
			method: "POST",
			path: "/acme/projects",
			route_type: "action",
			digest: "4242",
			err: { type: "DrizzleQueryError", cause: { code: "23505" } },
		});
		expect(line).not.toHaveProperty("stack");
	});

	it("logs an expected request error at debug, without the error", async () => {
		await onRequestError(
			Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/sign-in;307;" }),
			{ path: "/acme", method: "GET" },
			{ routePath: "/[org]", routeType: "render" },
		);
		const line = lineWithMsg("expected request error (not reported)");
		expect(line).toMatchObject({ level: "debug", path: "/acme" });
		expect(line).not.toHaveProperty("err");
		expect(lines).toHaveLength(1);
	});
});
