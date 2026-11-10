// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Job visibility follows project visibility (#6121): the predicate every jobs read applies, and the
// single-row form the log stream uses. The PDP is stubbed — what it answers is the PDP's own subject
// (tests/integration/postgres-rbac-pdp.test.ts); here, what the jobs reads do with that answer.

import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const listAccessible = vi.fn();
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ listAccessible }) }));

import { isJobVisible, jobVisibleTo, jobVisibleWhere, viewableProjectIds } from "@/lib/jobs/visibility";

const ACTOR = { userId: "u-1", orgId: "o-1" };
const dialect = new PgDialect();

/** The SQL text and bound params of a predicate. */
function render(predicate: Parameters<PgDialect["sqlToQuery"]>[0]) {
	return dialect.sqlToQuery(predicate);
}

beforeEach(() => {
	listAccessible.mockReset();
});

describe("job visibility follows project visibility", () => {
	it("asks the PDP which projects the reader may VIEW", async () => {
		listAccessible.mockResolvedValue(["p-1"]);
		expect(await viewableProjectIds(ACTOR)).toEqual(["p-1"]);
		expect(listAccessible).toHaveBeenCalledWith(ACTOR, "view", "project");
	});

	it("a reader who may view no project sees only project-less jobs that are not scans", () => {
		const q = render(jobVisibleWhere([]));
		expect(q.sql).toBe('("jobs"."project_id" is null and "jobs"."job_type" not in ($1, $2))');
		expect(q.params).toEqual(["IAC_SCAN", "CHART_SCAN"]);
	});

	it("a reader who may view some projects sees their jobs, the org-level ones, and the legacy scans of those projects", () => {
		const q = render(jobVisibleWhere(["p-1", "p-2"]));
		expect(q.sql).toBe(
			'(("jobs"."project_id" is null and "jobs"."job_type" not in ($1, $2)) or "jobs"."project_id" in ($3, $4) or ' +
				'("jobs"."project_id" is null and "jobs"."job_type" in ($5, $6) and "jobs"."config_snapshot"->>\'project_id\' in ($7, $8)))',
		);
		expect(q.params).toEqual(["IAC_SCAN", "CHART_SCAN", "p-1", "p-2", "IAC_SCAN", "CHART_SCAN", "p-1", "p-2"]);
	});

	it("builds the predicate from the PDP's answer for this reader", async () => {
		listAccessible.mockResolvedValue(["p-9"]);
		expect(render(await jobVisibleTo(ACTOR)).params).toEqual(["IAC_SCAN", "CHART_SCAN", "p-9", "IAC_SCAN", "CHART_SCAN", "p-9"]);
	});

	it("a job of a project the reader may not view is not visible; an org-level job always is", async () => {
		listAccessible.mockResolvedValue(["p-1"]);
		const job = (project_id: string | null, job_type: "DEPLOY" | "AUDIT" | "IAC_SCAN" = "DEPLOY") => ({
			job_type,
			project_id,
			environment_id: null,
		});
		expect(await isJobVisible(ACTOR, job("p-1"))).toBe(true);
		expect(await isJobVisible(ACTOR, job("p-2"))).toBe(false);
		expect(await isJobVisible(ACTOR, job(null, "AUDIT"))).toBe(true);
		// An org-level job needs no PDP answer at all.
		expect(listAccessible).toHaveBeenCalledTimes(2);
	});

	it("a scan stored with its project only in the snapshot follows THAT project; a scan naming none is hidden", async () => {
		listAccessible.mockResolvedValue(["p-1"]);
		const scan = (snapshotProject?: string) => ({
			job_type: "CHART_SCAN" as const,
			project_id: null,
			environment_id: null,
			config_snapshot: snapshotProject ? { project_id: snapshotProject } : {},
		});
		expect(await isJobVisible(ACTOR, scan("p-1"))).toBe(true);
		expect(await isJobVisible(ACTOR, scan("p-2"))).toBe(false);
		expect(await isJobVisible(ACTOR, scan())).toBe(false);
	});
});
