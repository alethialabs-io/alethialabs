// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Below `lg` the Elench thread rail opens as a left sheet over the modal (#5650), and it shipped
// with NO scrim (#5655, accepted as a recorded choice): the sheet mounts inside the modal, base-ui
// treats it as a nested dialog, and a nested dialog's backdrop renders only with `forceRender`,
// which `SheetContent` could not pass. Nothing dimmed, and nothing outside the panel read as the
// place to tap to dismiss it (#5706).
//
// The scrim is identified by `data-slot="sheet-overlay"` — the slot `@repo/ui/sheet` stamps on its
// overlay. The modal's own overlay is `dialog-overlay`, so counting the sheet slot cannot be
// satisfied by the modal. jsdom loads no stylesheet: the layer and the breakpoint are read off the
// class tokens (`bg-overlay`, `z-[var(--z-overlay-nested)]`, no bare `hidden` on the way up), which
// is where they exist. That the scrim actually paints below the panel is a rendered fact this file
// cannot see — it follows from the overlay being the panel's earlier sibling on the same layer.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElenchModal } from "@/components/agent/elench/elench-modal";
import type { AgentThread } from "@/lib/db/schema";
import { useElenchStore } from "@/lib/stores/use-elench-store";

vi.mock("@/components/agent/artifact-panel", () => ({ ArtifactPanel: () => null }));
vi.mock("@/components/agent/widgets/widget-grid", () => ({ WidgetGrid: () => null }));
vi.mock("@/components/agent/elench/elench-scope-chip", () => ({ ElenchScopeChip: () => null }));

/** One thread row for the rail. */
function threadRow(): AgentThread {
	const now = new Date();
	return {
		id: "t-1",
		org_id: "o1",
		user_id: "u1",
		project_id: null,
		title: "Audit chat",
		status: "active",
		kind: "agent",
		messages: [],
		billing_org_id: null,
		revision: 1,
		created_at: now,
		updated_at: now,
	};
}

/** True when nothing between `el` and the document root carries a bare Tailwind `hidden`. */
function shownBelowLg(el: Element): boolean {
	for (let n: Element | null = el; n; n = n.parentElement) {
		if (n.classList.contains("hidden")) return false;
	}
	return true;
}

/** Every sheet overlay in the document (the modal's own overlay is a different slot). */
function sheetScrims(): Element[] {
	return Array.from(document.querySelectorAll('[data-slot="sheet-overlay"]'));
}

/** Renders the modal on an active conversation with one thread in the rail. */
function renderModal(): void {
	render(
		<ElenchModal
			isOrg
			threads={[threadRow()]}
			activeId={null}
			isEmpty={false}
			title="A chat"
			onSelectThread={vi.fn<(id: string) => void>()}
			onNewChat={vi.fn<() => void>()}
			onDeleteThread={vi.fn<(id: string) => void>()}
		>
			<div>transcript</div>
		</ElenchModal>,
	);
}

/** Opens the narrow sheet from its toggle; resolves to the toggle once the sheet is up. */
async function openNarrowRail(): Promise<HTMLElement> {
	const toggle = screen.getByTestId("elench-narrow-rail-toggle");
	await userEvent.click(toggle);
	await screen.findByRole("dialog", { name: "Chats" });
	return toggle;
}

/** The one scrim on screen — exactly one, or the test fails. */
function theScrim(): Element {
	const scrims = sheetScrims();
	expect(scrims).toHaveLength(1);
	const [scrim] = scrims;
	if (!scrim) throw new Error("unreachable: length asserted above");
	return scrim;
}

/**
 * Resolves once the sheet has unmounted. base-ui keeps a closing popup mounted until its exit
 * animation settles, so an immediate query races it.
 */
async function sheetClosed(): Promise<void> {
	await waitFor(() => {
		expect(screen.queryByRole("dialog", { name: "Chats" })).toBeNull();
	});
}

describe("ElenchModal below lg — the thread-rail sheet has a scrim (#5706)", () => {
	beforeEach(() => {
		act(() => {
			useElenchStore.setState({ railOpen: true, mainView: "chat" });
		});
	});

	it("renders no scrim while the sheet is closed", () => {
		renderModal();
		expect(sheetScrims()).toHaveLength(0);
	});

	it("renders a scrim below lg when the sheet opens, on the sheet's layer, from the token", async () => {
		renderModal();
		await openNarrowRail();
		const scrim = theScrim();
		expect(shownBelowLg(scrim)).toBe(true);
		expect(scrim).toHaveClass("bg-overlay", "z-[var(--z-overlay-nested)]", "lg:hidden");
		// The panel shares the layer, so the scrim must come first to paint beneath it.
		const panel = screen.getByTestId("elench-narrow-rail");
		expect(panel).toHaveClass("z-[var(--z-overlay-nested)]");
		expect(
			scrim.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("closes the sheet on a scrim tap, keeps the modal open, and returns focus to the toggle", async () => {
		renderModal();
		const toggle = await openNarrowRail();
		await userEvent.click(theScrim());
		await sheetClosed();
		// Only the sheet closed: the modal it was opened from is still up.
		expect(screen.getByTestId("elench-modal")).toBeInTheDocument();
		await waitFor(() => {
			expect(toggle).toHaveFocus();
		});
	});

	it("still closes on Escape, keeping the modal, with focus back on the toggle", async () => {
		renderModal();
		const toggle = await openNarrowRail();
		await userEvent.keyboard("{Escape}");
		await sheetClosed();
		// Only the sheet closed: the modal it was opened from is still up.
		expect(screen.getByTestId("elench-modal")).toBeInTheDocument();
		await waitFor(() => {
			expect(toggle).toHaveFocus();
		});
	});
});
