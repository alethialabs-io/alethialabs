// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `personalRunnerArm` (#4298) — the one decision behind `assertRunnerInOrg`'s fourth argument.
//
// The argument admits a runner whose `org_id` equals the CALLER's own id: the pre-#3874
// compatibility path. For a session that id is the human's personal org and the arm is right. For a
// service token it is the MINTING profile, and passing it let a token pinned to org T assign an
// org-T job to the minter's personal runner — which `claim_next_job`'s legacy lifecycle arm then
// executes with the minter's personal cloud identity. A pin that bounds the job but not the
// executor bounds nothing.
//
// Pure: no db, no request. The value of a test over a one-line switch is that it pins the DIRECTION
// — the token answer must be `undefined`, and a future third credential kind must not silently
// inherit the wide one.

import { describe, expect, it } from "vitest";

import { personalRunnerArm } from "@/lib/authz/runner-org";
import type { Actor } from "@/lib/authz/types";

const MINTER: Actor = { userId: "u-minter", orgId: "org-t" };
const HUMAN: Actor = { userId: "u-human", orgId: "org-team" };

describe("personalRunnerArm", () => {
	it("gives a service token no personal arm at all", () => {
		expect(personalRunnerArm(MINTER, "service_token")).toBeUndefined();
	});

	it("never returns the minter's id for a token", () => {
		expect(personalRunnerArm(MINTER, "service_token")).not.toBe(MINTER.userId);
	});

	it("gives a session its own personal org", () => {
		expect(personalRunnerArm(HUMAN, "session")).toBe("u-human");
	});

	// The two answers must differ for the SAME actor, or the function is decorative and a call site
	// could pass either credential and not notice.
	it("answers differently for the two credentials on one actor", () => {
		expect(personalRunnerArm(MINTER, "session")).not.toBe(
			personalRunnerArm(MINTER, "service_token"),
		);
	});
});
