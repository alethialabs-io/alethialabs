// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6828 — the support P3 findings that live in small pieces:
//   G-23  an unread case row says "Unread" to a screen reader, not only with a dot;
//   G-17  the documentation, news and status links open in a new tab and say so;
//   G-25  the case not-found copy is one wording with a globalHref way back;
//   G-26  the per-case draft store tolerates storage that refuses.

import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCaseDraft, writeCaseDraft } from "@/components/support/cases/case-draft";
import { CaseListItem } from "@/components/support/cases/case-list-item";
import { CaseNotFound } from "@/components/support/cases/case-not-found";
import { SupportBrowseTopics } from "@/components/support/support-topics";
import { SupportWhatsNew } from "@/components/support/support-whats-new";
import type { CaseListItem as CaseListItemData } from "@/lib/queries/support";

/** A case row, unread or not. */
function row(unread: boolean): CaseListItemData {
	const at = new Date("2026-10-19T08:00:00.000Z");
	return {
		id: "11111111-1111-4111-8111-111111111111",
		case_number: 12,
		subject: "Runner cannot reach the registry",
		type: "technical",
		category: "other",
		severity: "normal",
		status: "open",
		last_message_at: at,
		last_author_type: "staff",
		created_at: at,
		unread,
		requester_name: null,
		is_mine: true,
	};
}

describe("CaseListItem — unread (G-23)", () => {
	it("an unread row's link carries the word 'Unread'", () => {
		render(<CaseListItem item={row(true)} orgSlug="acme" />);
		expect(screen.getByRole("link")).toHaveAccessibleName(/^Unread/);
	});

	it("a read row says nothing about it", () => {
		render(<CaseListItem item={row(false)} orgSlug="acme" />);
		expect(screen.getByRole("link")).not.toHaveAccessibleName(/Unread/);
	});
});

describe("support hub links (G-17)", () => {
	/** Every link that does not open in a new tab, or does not say so. */
	function sameTabLinks(container: HTMLElement): string[] {
		return within(container)
			.getAllByRole("link")
			.filter(
				(a) =>
					a.getAttribute("target") !== "_blank" ||
					a.getAttribute("rel") !== "noopener noreferrer" ||
					!(a.textContent ?? "").includes("(opens in a new tab)"),
			)
			.map((a) => a.getAttribute("href") ?? "");
	}

	it("every topic link opens the docs in a new tab and says so", () => {
		const { container } = render(<SupportBrowseTopics />);
		expect(within(container).getAllByRole("link").length).toBeGreaterThan(0);
		expect(sameTabLinks(container)).toEqual([]);
	});

	it("every what's-new link opens in a new tab and says so", () => {
		const { container } = render(<SupportWhatsNew />);
		expect(within(container).getAllByRole("link").length).toBe(3);
		expect(sameTabLinks(container)).toEqual([]);
	});
});

describe("CaseNotFound (G-25)", () => {
	it("says the shared copy and links back with globalHref", () => {
		render(<CaseNotFound orgSlug="acme" />);
		expect(screen.getByText("Case not found")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Back to cases" })).toHaveAttribute("href", "/acme/~/support/my-cases");
	});
});

describe("case drafts (G-26)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		window.sessionStorage.clear();
	});

	it("keeps a draft per case and drops a blank one", () => {
		writeCaseDraft("a", "first");
		writeCaseDraft("b", "second");
		expect(readCaseDraft("a")).toBe("first");
		expect(readCaseDraft("b")).toBe("second");
		writeCaseDraft("a", "   ");
		expect(readCaseDraft("a")).toBe("");
	});

	it("reads nothing and throws nothing when storage refuses", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(() => writeCaseDraft("a", "text")).not.toThrow();
		expect(readCaseDraft("a")).toBe("");
	});
});
