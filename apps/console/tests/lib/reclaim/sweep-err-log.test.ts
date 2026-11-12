// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The orphan sweep logs a job's failed sweep through the logger's `err` serializer
// (lib/observability/log.ts): the error is passed under `err` as the error itself, not as
// `String(err)` — a string skips the serializer, so it writes the error's whole text unexamined.
// The logger here is the real one, writing to a captured stream, so the assertions read the line.

import { DrizzleQueryError } from "drizzle-orm/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every JSON line the sweep's logger wrote, parsed. */
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

/** The one orphan-risk job the queue query returns. */
const orphanJob = {
	id: "job-1",
	provider: "hetzner",
	cloud_identity_id: "ci-1",
	project_id: "p",
	environment_id: "6f2c1e34-9a77-4d18-8b21-0f5a7c9e4d10",
	project_name: "acme-prod",
	environment_name: "7f3a",
	started_at: new Date("2026-07-14T12:00:00Z"),
	job_type: "DEPLOY",
	config_snapshot: {},
};

/** A drizzle-ish stub whose select chain resolves the queue to `orphanJob`. */
const db: Record<string, unknown> = {};
Object.assign(db, {
	select: () => db,
	from: () => db,
	leftJoin: () => db,
	where: () => db,
	limit: () => Promise.resolve([orphanJob]),
});
vi.mock("@/lib/db", () => ({ getServiceDb: () => db }));

const list = vi.fn();
vi.mock("@/lib/reclaim/providers", () => ({
	adapterFor: () => ({
		provider: "hetzner",
		list: (...a: unknown[]) => list(...a),
		delete: vi.fn(),
		deleteOrder: ["server"],
	}),
}));
vi.mock("@/lib/reclaim/state", () => ({ stateNativeIds: async () => new Set<string>() }));
vi.mock("@/lib/observability/heartbeats", () => ({
	registerLoop: vi.fn(),
	superviseLoop: vi.fn(),
}));
vi.mock("@/lib/storage/tofu-state", () => ({
	stateKeyForJob: () => ({ key: "projects/p/e/tofu.tfstate" }),
	TOFU_STATE_BUCKET: "project-tofu-state",
}));

import { sweepOrphans } from "@/lib/reclaim/sweep";

/** A multi-line SQL text, as drizzle builds for a longer query. */
const SQL = 'select "id"\nfrom "users"\nwhere "email" = $1';
/** The bound parameter values of the failed query. */
const PARAMS = ["a@b.c"];
/** A value planted on the error as an enumerable field; the serializer never writes it. */
const PLANTED = "planted-enumerable-field-value";

/** Builds a real drizzle-orm query error, caused by a driver error, with a planted field. */
function queryError(): DrizzleQueryError {
	const cause = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
	return Object.assign(new DrizzleQueryError(SQL, PARAMS, cause), { connection: PLANTED });
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
	list.mockReset();
});

describe("sweepOrphans — a failed sweep is logged through the err serializer", () => {
	it("writes the job's sweep error as the serializer writes it, and moves on", async () => {
		list.mockRejectedValue(queryError());
		expect(await sweepOrphans()).toBe(0);
		const line = lineWithMsg("orphan reclaim: sweep failed");
		expect(JSON.stringify(line)).not.toContain(PLANTED);
		expect(line).toMatchObject({
			job_id: "job-1",
			err: { type: "DrizzleQueryError", cause: { code: "ECONNREFUSED" } },
		});
	});
});
