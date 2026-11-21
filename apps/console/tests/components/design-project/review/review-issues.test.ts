// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The review view's issue list (#6833), against the REAL save-path validation: every issue names a
// card or a part of the design in words, no validator path reaches the strings a person reads, and
// an issue on one of several cards of a kind lands on that card and not on its neighbour.

import { beforeEach, describe, expect, it } from "vitest";
import {
	reviewIssues,
	type ReviewIssue,
} from "@/components/design-project/canvas/review/review-issues";
import { board } from "@/lib/canvas/store/board";
import { PROJECT_NODE_ID } from "@/lib/canvas/store/types";

/** The design on the board. */
function design() {
	return board.document.getState().designNodes;
}

/** Everything of an issue that is shown to a person. */
function shown(issue: ReviewIssue): string {
	return [issue.subject, issue.field ?? "", issue.message].join(" | ");
}

beforeEach(() => {
	board.reset();
});

describe("reviewIssues", () => {
	it("lists what an unconfigured project is missing, on the project's card", () => {
		const issues = reviewIssues(design());
		expect(issues.length).toBeGreaterThan(0);
		const onProject = issues.filter((issue) => issue.nodeId === PROJECT_NODE_ID);
		expect(onProject.length).toBeGreaterThan(0);
		expect(onProject.every((issue) => issue.subject.startsWith("Project"))).toBe(true);
	});

	it("never shows a validator path: no dotted key, no array index, no snake_case", () => {
		board.document.getState().addNode("database");
		board.document.getState().addNode("database");
		const second = design().filter((n) => n.data.kind === "database")[1];
		board.document.getState().updateNodeConfig(second.id, { name: "" });

		const offenders = reviewIssues(design())
			.map((issue) => `${issue.subject} | ${issue.field ?? ""}`)
			.filter((text) => /[a-z]_[a-z]/.test(text) || /\.\d/.test(text) || /\w\.\w/.test(text));
		expect(offenders).toEqual([]);
	});

	it("puts an issue on the card it is about, not on another card of the same kind", () => {
		board.document.getState().addNode("database");
		board.document.getState().addNode("database");
		const [first, second] = design().filter((n) => n.data.kind === "database");
		const before = reviewIssues(design());

		board.document.getState().updateNodeConfig(second.id, { name: "" });
		const after = reviewIssues(design());

		const on = (list: ReviewIssue[], id: string) => list.filter((i) => i.nodeId === id).map(shown);
		expect(on(after, first.id)).toEqual(on(before, first.id));
		expect(on(after, second.id).length).toBeGreaterThan(on(before, second.id).length);
		const added = after.find(
			(issue) => issue.nodeId === second.id && !on(before, second.id).includes(shown(issue)),
		);
		expect(added?.field).toBe("Name");
		expect(added?.fieldPath).toBe("name");
	});

	it("reports a connection to a resource that is not on the board, and stops when it is added", () => {
		const document = board.document.getState();
		const { id: serviceId } = document.addNodeWithConfig(
			"service",
			{ name: "api", bindings: [{ target: { kind: "database", name: "orders" }, inject: [] }] },
			null,
			undefined,
			null,
		);
		const missing = reviewIssues(design()).filter((issue) => issue.key.startsWith("binding-"));
		expect(missing).toHaveLength(1);
		expect(missing[0]).toMatchObject({
			nodeId: serviceId,
			field: "Connections",
			fieldPath: "bindings",
		});
		expect(missing[0].message).toContain("orders");

		board.document
			.getState()
			.addNodeWithConfig("database", { name: "orders" }, null, undefined, null);
		expect(reviewIssues(design()).filter((issue) => issue.key.startsWith("binding-"))).toEqual([]);
	});

	it("gives every issue a key that is unique in the list", () => {
		board.document.getState().addNode("database");
		const keys = reviewIssues(design()).map((issue) => issue.key);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
