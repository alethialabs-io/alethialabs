// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Queueing a project's job from an org the project does not live in is refused in a sentence, as a
// typed error, before the database would refuse the stamp as a constraint error (#6121).

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { byoWriteError } from "@/lib/cli/byo-write";
import { ProjectOrgRefusalError, refuseProjectOfAnotherOrg } from "@/lib/projects/refuse-other-org";

/** A transaction whose project lookup answers `rows`. */
function txAnswering(rows: unknown[]) {
	const chain = { select: () => chain, from: () => chain, where: () => chain, limit: async () => rows };
	return chain;
}

const ACTOR = { userId: "u-1", orgId: "org-1" };

describe("refuseProjectOfAnotherOrg", () => {
	it("lets a project of the actor's org through", async () => {
		await expect(refuseProjectOfAnotherOrg(txAnswering([{ org_id: "org-1" }]) as never, "p-1", ACTOR)).resolves.toBeUndefined();
	});

	it.each([
		[[{ org_id: "org-2" }], "This project belongs to another organization — switch to it to run this."],
		[[{ org_id: "u-1" }], "This project belongs to your personal workspace — switch to it to run this."],
		[[], "This project belongs to another organization — switch to it to run this."],
	])("refuses %o as a typed error with a sentence", async (rows, sentence) => {
		const error = await refuseProjectOfAnotherOrg(txAnswering(rows) as never, "p-1", ACTOR).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(ProjectOrgRefusalError);
		expect(error).toMatchObject({ message: sentence });
	});
});

describe("the CLI's answer to it", () => {
	it("is a 409 carrying the sentence, not a 500", async () => {
		const res = byoWriteError(new ProjectOrgRefusalError("This project belongs to another organization — switch to it to run this."));
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "This project belongs to another organization — switch to it to run this." });
	});
});
