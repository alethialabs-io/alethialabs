// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the Activity humanizer: that a raw row becomes the right bold-able segments
// ({actor, lead, target, denied, detail}) across allowed/denied actions, member lifecycle,
// resource-name resolution, and the actor fallback chain.

import { describe, expect, it } from "vitest";
import type { ActivityRow } from "@/app/server/actions/activity";
import {
	type ActivityContext,
	describeEvent,
} from "@/components/settings/activity/humanize-event";

/** A context that resolves a single known project, nothing else. */
const ctx: ActivityContext = {
	resolveName: (type, id) =>
		type === "project" && id === "project-1" ? "my-api" : null,
};

/** Builds an ActivityRow with sensible allowed-action defaults. */
function row(over: Partial<ActivityRow> = {}): ActivityRow {
	return {
		id: "1",
		actorId: "u-1",
		actorName: "Boris Petrov",
		actorEmail: "boris@x.io",
		actorImage: null,
		actorUsername: null,
		action: "create",
		resourceType: "project",
		resourceId: "project-1",
		decision: true,
		reason: null,
		ts: "2026-06-20T10:00:00.000Z",
		...over,
	};
}

describe("describeEvent — allowed actions", () => {
	it("splits a resource action into verb lead + bold target", () => {
		const e = describeEvent(row(), ctx);
		expect(e).toMatchObject({ lead: "created", target: "project my-api", denied: false });
	});

	it("falls back to an indefinite noun when the resource name is unknown", () => {
		const e = describeEvent(row({ resourceId: "unknown" }), ctx);
		expect(e.target).toBe("a project");
	});

	it("maps alert management to 'updated' + 'alert settings'", () => {
		const e = describeEvent(
			row({ action: "manage_alerts", resourceType: "alert", resourceId: null }),
			ctx,
		);
		expect(e).toMatchObject({ lead: "updated", target: "alert settings", denied: false });
	});

	it("describes member lifecycle without a duplicate noun", () => {
		const join = describeEvent(
			row({ action: "join", resourceType: "member", resourceId: "u-1" }),
			ctx,
		);
		expect(join).toMatchObject({ lead: "joined", target: "the organization" });

		const roleChange = describeEvent(
			row({ action: "role_change", resourceType: "member" }),
			ctx,
		);
		expect(roleChange).toMatchObject({ lead: "had their role changed", target: null });
	});
});

describe("describeEvent — denials", () => {
	it("renders 'was denied' + the attempted action, with the reason as detail", () => {
		const e = describeEvent(
			row({
				action: "export_activity",
				resourceType: "activity",
				resourceId: null,
				decision: false,
				reason: "Activity export requires the Enterprise plan",
			}),
			ctx,
		);
		expect(e).toMatchObject({
			denied: true,
			lead: "was denied",
			target: "an activity-log export",
			detail: "Activity export requires the Enterprise plan",
		});
	});
});

describe("describeEvent — actor fallback", () => {
	it("uses the name and surfaces the email on the detail line", () => {
		const e = describeEvent(row({ actorName: "Boris Petrov", actorEmail: "boris@x.io" }), ctx);
		expect(e.actor).toBe("Boris Petrov");
		expect(e.detail).toBe("boris@x.io");
	});

	it("falls back to username, then email local-part", () => {
		expect(
			describeEvent(row({ actorName: null, actorUsername: "ada", actorEmail: "ada@x.io" }), ctx)
				.actor,
		).toBe("ada");
		expect(
			describeEvent(row({ actorName: null, actorUsername: null, actorEmail: "borislav@tovr.eu" }), ctx)
				.actor,
		).toBe("borislav");
	});

	it("does not repeat the email as detail when it is already the label", () => {
		const e = describeEvent(
			row({ actorName: null, actorUsername: null, actorEmail: "borislav@tovr.eu" }),
			ctx,
		);
		// Label is the local-part "borislav"; the full email is still useful below it.
		expect(e.detail).toBe("borislav@tovr.eu");
	});
});
