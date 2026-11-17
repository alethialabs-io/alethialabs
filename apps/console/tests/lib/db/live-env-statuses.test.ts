// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit: which environment statuses block a delete, and the sentence an organization delete is
// refused with (#6752). The two actions that refuse on them are tested next to this file:
// live-env-statuses.environment-delete.test.ts and live-env-statuses.organization-delete.test.ts.
//
// The expected verdict per status is WRITTEN OUT below rather than derived from the set under test,
// and the table is held against the enum, so a status added to `project_status` fails here until
// someone decides which side of the line it is on.

import { describe, expect, it } from "vitest";
import {
	isLiveEnvStatus,
	LIVE_ENV_STATUSES,
	LIVE_ENVIRONMENTS_NAMED,
	type LiveEnvironment,
	liveEnvironmentsRefusal,
} from "@/lib/db/live-env-statuses";
import { type ProjectStatus, projectStatus } from "@/lib/db/schema/enums";

/** Every status, and whether an environment in it blocks a delete. */
const BLOCKS: Record<ProjectStatus, boolean> = {
	DRAFT: false,
	QUEUED: true,
	PROVISIONING: true,
	ACTIVE: true,
	FAILED: false,
	DESTROYING: true,
	DESTROYED: false,
};

/** `count` blockers named p01/e01, p02/e02, … */
function blockers(count: number): LiveEnvironment[] {
	return Array.from({ length: count }, (_unused, i) => {
		const n = String(i + 1).padStart(2, "0");
		return { projectName: `p${n}`, environmentName: `e${n}` };
	});
}

describe("isLiveEnvStatus", () => {
	it("has a decision for every status the enum holds", () => {
		expect(Object.keys(BLOCKS).sort()).toEqual([...projectStatus.enumValues].sort());
	});

	it.each(projectStatus.enumValues)("%s", (status) => {
		expect(isLiveEnvStatus(status)).toBe(BLOCKS[status]);
	});

	it("is the same answer the exported set gives", () => {
		const live = projectStatus.enumValues.filter((s) => BLOCKS[s]);
		expect([...LIVE_ENV_STATUSES].sort()).toEqual([...live].sort());
	});
});

describe("liveEnvironmentsRefusal", () => {
	it("names the one environment, in the singular", () => {
		expect(liveEnvironmentsRefusal([{ projectName: "Shop", environmentName: "prod" }])).toBe(
			"This organization has a live or in-flight environment: Shop / prod. Destroy it before deleting the organization.",
		);
	});

	it("names every environment up to the limit, with no count of the rest", () => {
		expect(LIVE_ENVIRONMENTS_NAMED).toBe(5);
		expect(liveEnvironmentsRefusal(blockers(5))).toBe(
			"This organization has live or in-flight environments: p01 / e01, p02 / e02, p03 / e03, p04 / e04, p05 / e05. Destroy them before deleting the organization.",
		);
	});

	it("names five and counts the rest", () => {
		const sentence = liveEnvironmentsRefusal(blockers(8));
		expect(sentence).toBe(
			"This organization has live or in-flight environments: p01 / e01, p02 / e02, p03 / e03, p04 / e04, p05 / e05 and 3 more. Destroy them before deleting the organization.",
		);
		expect(sentence).not.toContain("p06");
	});
});
