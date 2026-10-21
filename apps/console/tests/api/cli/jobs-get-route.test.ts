// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// GET /api/cli/jobs/:id returns the job's snapshot through the one read-side redaction
// (lib/jobs/redact-snapshot.ts): a deny-listed key never reaches the CLI, whatever the row holds.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { GET } from "@/app/api/cli/jobs/[id]/route";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { makeJob } from "../../fixtures/jobs";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const SENTINEL = "SENTINEL-cli-get-2c84";

let row: unknown;

/** A drizzle stand-in whose single select resolves to `row`. */
function fakeDb() {
	const chain = {
		from: () => chain,
		where: () => chain,
		limit: () => Promise.resolve(row ? [row] : []),
	};
	return { select: () => chain };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorizeCli).mockResolvedValue({
		actor: { credential: "session", userId: USER, orgId: ORG },
		credential: "session",
		orgScope: [ORG, USER],
	});
	vi.mocked(getServiceDb).mockReturnValue(fakeDb() as never);
});

describe("GET /api/cli/jobs/:id — snapshot redaction", () => {
	it("returns the snapshot without its deny-listed keys", async () => {
		// The joined display fields makeJob adds are stripped by the wire contract.
		row = makeJob({
			id: JOB_ID,
			org_id: ORG,
			user_id: USER,
			project_id: null,
			job_type: "UPDATE_RUNNER",
			config_snapshot: { runner_id: "r-1", runner_token: SENTINEL, image_tag: "1.2.3" },
		});
		const res = await GET(new Request(`http://console.test/api/cli/jobs/${JOB_ID}`), {
			params: Promise.resolve({ id: JOB_ID }),
		});
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain('"image_tag":"1.2.3"');
		expect(text).not.toContain(SENTINEL);
	});
});
