// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pins the EXTERNAL status ladder — the states of a bring-your-own IaC module's cards.
//
// node-status.ts says it out loud: a status system rots when someone adds a state and slots it in
// "somewhere reasonable", and the board starts lying. So the order is asserted here, not just
// written down. Every test below is a precedence claim, and each one names what it outranks.

import { describe, expect, it } from "vitest";
import { resolveExternalStatus } from "@/lib/canvas/node-status";
import type { ComponentServerStatus, IacEnvironment } from "@/lib/canvas/component-status";

type Source = IacEnvironment["source"];

/** A scanned-clean, never-deployed module. */
const SOURCE: Source = {
	repoUrl: "https://github.com/acme/infra",
	ref: "main",
	path: "",
	commitSha: "abc123",
	deployedCommitSha: null,
	scanStatus: "done",
	scanOk: true,
	status: "PENDING",
	statusMessage: null,
};

const source = (patch: Partial<Source> = {}): Source => ({ ...SOURCE, ...patch });

/** A deployed module (the common steady state). */
const deployed = (patch: Partial<Source> = {}) =>
	source({ deployedCommitSha: "abc123", status: "ACTIVE", ...patch });

const server = (patch: Partial<ComponentServerStatus> = {}): ComponentServerStatus => ({
	lifecycle: "ACTIVE",
	message: null,
	drift: [],
	...patch,
});

/** A group whose resources the last plan left alone — i.e. live and unchanged. */
const noop = { source: "plan" as const, members: [{ action: "no-op" }] };
/** A group the last plan would still change. */
const changing = { source: "plan" as const, members: [{ action: "no-op" }, { action: "update" }] };
/** A group from the static scan — declared only, so it carries no actions at all. */
const declared = { source: "scan" as const, members: [{}] };

const NO_JOB = { activeJob: null };
const RUNNING_JOB = {
	activeJob: { id: "j1", type: "DEPLOY", status: "PROCESSING" },
} satisfies Parameters<typeof resolveExternalStatus>[3];

describe("resolveExternalStatus — the precedence ladder", () => {
	it("1. FAILED outranks everything, including a clean scan and a live deploy", () => {
		const s = resolveExternalStatus(
			noop,
			deployed(),
			server({ lifecycle: "FAILED", message: "apply exploded" }),
			NO_JOB,
		);
		expect(s.state).toBe("failed");
		expect(s.message).toBe("apply exploded");
	});

	it("2. in-flight outranks the design — what's HAPPENING beats what's wrong", () => {
		expect(
			resolveExternalStatus(noop, deployed(), server({ lifecycle: "CREATING" }), NO_JOB).state,
		).toBe("applying");
		expect(
			resolveExternalStatus(noop, deployed(), server({ lifecycle: "DESTROYING" }), NO_JOB).state,
		).toBe("destroying");
	});

	it("2b. a queued job on a never-deployed module reads as queued, not not-deployed", () => {
		const s = resolveExternalStatus(noop, source(), server({ lifecycle: "PENDING" }), RUNNING_JOB);
		expect(s.state).toBe("queued");
		expect(s.deployed).toBe(false);
	});

	it("3. a REJECTED module is needs-setup — even while its resources are live", () => {
		// Fail-closed, and the important one: the safety gate blocks provisioning server-side, so the
		// next deploy will NOT run. The board must say so over the top of a live module, because the
		// deploy the user is about to press is the thing that matters.
		const s = resolveExternalStatus(noop, deployed({ scanOk: false }), server(), NO_JOB);
		expect(s.state).toBe("needs-setup");
		expect(s.message).toMatch(/rejected/i);
	});

	it("3b. an UNSCANNED module is needs-setup — an unknown is not a pass", () => {
		const s = resolveExternalStatus(
			declared,
			source({ scanOk: null, scanStatus: "unscanned" }),
			server({ lifecycle: "PENDING" }),
			NO_JOB,
		);
		expect(s.state).toBe("needs-setup");
		expect(s.message).toMatch(/not been scanned/i);
	});

	it("4. scanned clean but never applied → not deployed", () => {
		const s = resolveExternalStatus(noop, source(), server({ lifecycle: "PENDING" }), NO_JOB);
		expect(s.state).toBe("not-deployed");
		expect(s.deployed).toBe(false);
	});

	it("5. deployed, but the last plan would still change these resources → update pending", () => {
		expect(resolveExternalStatus(changing, deployed(), server(), NO_JOB).state).toBe(
			"update-pending",
		);
	});

	it("6. deployed and the last plan says no-op → live", () => {
		const s = resolveExternalStatus(noop, deployed(), server(), NO_JOB);
		expect(s.state).toBe("live");
		expect(s.deployed).toBe(true);
	});

	it("a DECLARED group never claims update-pending — a scan carries no actions to justify it", () => {
		// The static scan cannot know what a deploy would do. Inferring "unchanged" from the ABSENCE
		// of an action would dress a guess up as a fact; the group reads live because the module IS
		// deployed, and the card's own `Source: declared` fact is what admits the uncertainty.
		expect(resolveExternalStatus(declared, deployed(), server(), NO_JOB).state).toBe("live");
	});
});

describe("resolveExternalStatus — drift and cost are OVERLAYS, never states", () => {
	it("a drifted card is still live, and carries its drift alongside", () => {
		// The rule that stops the status system degenerating into one state per combination.
		const drift: ComponentServerStatus["drift"] = [
			{ address: "aws_vpc.main", type: "aws_vpc", kind: "modified" },
		];
		const s = resolveExternalStatus(noop, deployed(), server({ drift }), NO_JOB);
		expect(s.state).toBe("live");
		expect(s.drift).toHaveLength(1);
	});

	it("drift survives every state — it rides on failed too", () => {
		const drift: ComponentServerStatus["drift"] = [
			{ address: "aws_vpc.main", type: "aws_vpc", kind: "modified" },
		];
		const s = resolveExternalStatus(
			noop,
			deployed(),
			server({ lifecycle: "FAILED", drift }),
			NO_JOB,
		);
		expect(s.state).toBe("failed");
		expect(s.drift).toHaveLength(1);
	});

	it("an unpriced card reports null, never $0 — a fabricated zero is worse, because you'd believe it", () => {
		expect(resolveExternalStatus(noop, deployed(), server(), NO_JOB).monthlyCost).toBeNull();
		expect(
			resolveExternalStatus(noop, deployed(), server({ monthlyCost: 12.4 }), NO_JOB).monthlyCost,
		).toBe(12.4);
	});
});
