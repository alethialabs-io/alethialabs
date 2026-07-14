// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// segmentMentions splits the composer value into plain-text + bold-badge nodes so tagged
// @mentions render distinctly from prose in the highlight mirror.

import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { segmentMentions } from "@/components/agent/elench/elench-composer";
import type { Mention } from "@/lib/ai/mentions";

const web: Mention = { id: "c1", type: "cluster", label: "web" };
const api: Mention = { id: "p1", type: "project", label: "api" };

/** The visible text of a node (badge element → its string child). */
function textOf(n: ReactNode): string {
	if (typeof n === "string") return n;
	if (isValidElement(n))
		return (n.props as { children?: string }).children ?? "";
	return "";
}

/** Reconstruct the value from the segments, dropping the trailing height sentinel. */
function joined(nodes: ReactNode[]): string {
	return nodes.map(textOf).join("").replace(/\u200b$/, "");
}

describe("segmentMentions", () => {
	it("wraps each tagged @token in a badge element and leaves prose as strings", () => {
		const nodes = segmentMentions("see @web now", [web]);
		const badges = nodes.filter(isValidElement);
		expect(badges).toHaveLength(1);
		expect(textOf(badges[0])).toBe("@web");
		// Plain text is preserved verbatim around the badge.
		expect(joined(nodes)).toBe("see @web now");
	});

	it("highlights multiple distinct mentions", () => {
		const nodes = segmentMentions("@api uses @web", [api, web]);
		const badges = nodes.filter(isValidElement).map(textOf);
		expect(badges).toEqual(["@api", "@web"]);
		expect(joined(nodes)).toBe("@api uses @web");
	});

	it("does not highlight an @word that isn't a tagged mention", () => {
		const nodes = segmentMentions("email @nobody please", [web]);
		expect(nodes.filter(isValidElement)).toHaveLength(0);
		expect(joined(nodes)).toBe("email @nobody please");
	});

	it("returns the value intact (plus sentinel) when there are no mentions", () => {
		const nodes = segmentMentions("just text", []);
		expect(nodes.filter(isValidElement)).toHaveLength(0);
		expect(joined(nodes)).toBe("just text");
	});
});
