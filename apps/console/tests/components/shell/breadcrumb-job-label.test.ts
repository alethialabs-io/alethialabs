// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A job's crumb on its own page (R6 S-15). The trail names a job from the shell's recent-jobs feed,
// which holds twenty; a job outside it used to be crumbed `1a2b3c4d…`, an id fragment that named
// nothing a person could recognise. It now reads "Job", as an unresolved case reads "Case".

import { describe, expect, it } from "vitest";
import { UNRESOLVED_JOB_LABEL, buildCrumbs } from "@/components/shell/breadcrumb-trail";

const JOB_ID = "1a2b3c4d-0000-4000-8000-000000000001";

describe("the job crumb", () => {
	it("is the job's type when the resolver knows the job", () => {
		const crumbs = buildCrumbs(`/acme/~/jobs/${JOB_ID}`, (id) => (id === JOB_ID ? "Deploy" : undefined));
		expect(crumbs.map((c) => c.label)).toEqual(["Jobs", "Deploy"]);
	});

	it("is \"Job\", never an id fragment, when the resolver does not", () => {
		const crumbs = buildCrumbs(`/acme/~/jobs/${JOB_ID}`);
		expect(crumbs.map((c) => c.label)).toEqual(["Jobs", UNRESOLVED_JOB_LABEL]);
		expect(UNRESOLVED_JOB_LABEL).toBe("Job");
		const fragments = crumbs.filter((c) => c.label.includes(JOB_ID.slice(0, 8)));
		expect(fragments).toEqual([]);
	});

	it("is \"Job\" on the legacy dashboard trail too", () => {
		const crumbs = buildCrumbs(`/dashboard/jobs/${JOB_ID}`);
		expect(crumbs.at(-1)?.label).toBe(UNRESOLVED_JOB_LABEL);
	});
});
