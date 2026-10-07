// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Below `lg` (1024px) a chat could not be deleted from anywhere (#5650). The modal's thread rail —
// the only surface that renders `Delete chat <title>` — sat in a `hidden … lg:flex` column, and its
// "Open sidebar" toggle only flipped the store's `railOpen`, which changes nothing on screen below
// `lg`; with `railOpen` at its default `true` the toggle was not rendered at all.
//
// HOW "BELOW lg" IS MODELLED HERE. jsdom loads no stylesheet, so a `hidden lg:flex` element is as
// present to Testing Library as a visible one — which is exactly how this defect passed every
// component test: the rail's Delete buttons WERE in the DOM, inside a column no narrow screen
// displays. The breakpoint is therefore read off the class tokens, the only place it exists:
// `shownBelowLg` walks from a node to the root and fails on a bare `hidden` token anywhere on the
// way (Tailwind's `hidden` is `display:none`, and an un-prefixed one applies below `lg`). An
// `lg:hidden` token is the opposite — hidden only AT `lg` — and is allowed. What this does NOT
// see: a node hidden by any other means (an inline style, `sr-only`, `invisible`, a `max-lg:`
// variant). The modal uses none of them for this; a Playwright run at a narrow viewport is the
// rendered proof, and none exists yet.

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElenchModal } from "@/components/agent/elench/elench-modal";
import type { AgentThread } from "@/lib/db/schema";
import { useElenchStore } from "@/lib/stores/use-elench-store";

vi.mock("@/components/agent/artifact-panel", () => ({ ArtifactPanel: () => null }));
vi.mock("@/components/agent/widgets/widget-grid", () => ({ WidgetGrid: () => null }));
vi.mock("@/components/agent/elench/elench-scope-chip", () => ({ ElenchScopeChip: () => null }));

/** One thread row for the rail (the destructive audit's title, so the two read alike). */
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

/** The "Open sidebar" control a narrow screen actually displays — exactly one, or the test fails. */
function narrowToggle(): HTMLElement {
	const shown = screen
		.getAllByRole("button", { name: "Open sidebar" })
		.filter(shownBelowLg);
	expect(shown).toHaveLength(1);
	const [toggle] = shown;
	if (!toggle) throw new Error("unreachable: length asserted above");
	return toggle;
}

interface Handlers {
	onSelectThread: ReturnType<typeof vi.fn<(id: string) => void>>;
	onNewChat: ReturnType<typeof vi.fn<() => void>>;
	onDeleteThread: ReturnType<typeof vi.fn<(id: string) => void>>;
}

/** Renders the modal with one thread in the rail; `isEmpty` picks the landing or the top bar. */
function renderModal({ isEmpty }: { isEmpty: boolean }): Handlers {
	const h: Handlers = {
		onSelectThread: vi.fn<(id: string) => void>(),
		onNewChat: vi.fn<() => void>(),
		onDeleteThread: vi.fn<(id: string) => void>(),
	};
	render(
		<ElenchModal
			isOrg
			threads={[threadRow()]}
			activeId={null}
			isEmpty={isEmpty}
			title="A chat"
			onSelectThread={h.onSelectThread}
			onNewChat={h.onNewChat}
			onDeleteThread={h.onDeleteThread}
			gallery={<div>gallery body</div>}
			knowledge={<div>knowledge body</div>}
		>
			<div>transcript</div>
		</ElenchModal>,
	);
	return h;
}

/**
 * Resolves once the sheet has unmounted. base-ui keeps a closing popup mounted (`data-closed`,
 * `data-ending-style`) until its exit animation settles, so an immediate query races it under a
 * loaded worker — measured: green alone, red inside the full `tests/components` run.
 */
async function sheetClosed(): Promise<void> {
	await waitFor(() => {
		expect(screen.queryByRole("dialog", { name: "Chats" })).toBeNull();
	});
}

/** The sheet, once open — the rail's narrow host. */
async function openNarrowRail(): Promise<HTMLElement> {
	await userEvent.click(narrowToggle());
	return screen.findByRole("dialog", { name: "Chats" });
}

describe("ElenchModal below lg — the thread rail is reachable (#5650)", () => {
	beforeEach(() => {
		act(() => {
			useElenchStore.setState({ railOpen: true, mainView: "chat" });
		});
	});

	for (const isEmpty of [false, true]) {
		const where = isEmpty ? "the empty landing" : "an active conversation";

		it(`renders a narrow toggle on ${where} while railOpen is at its default true`, () => {
			renderModal({ isEmpty });
			expect(narrowToggle()).toBeInTheDocument();
		});

		it(`opens the rail in a sheet on ${where}, and Delete chat works there`, async () => {
			const h = renderModal({ isEmpty });
			const sheet = await openNarrowRail();
			const del = within(sheet).getByRole("button", { name: "Delete chat Audit chat" });
			expect(shownBelowLg(del)).toBe(true);
			await userEvent.click(del);
			const confirm = await screen.findByRole("alertdialog");
			await userEvent.click(within(confirm).getByRole("button", { name: "Delete chat" }));
			expect(h.onDeleteThread).toHaveBeenCalledWith("t-1");
		});
	}

	it("opens the sheet when the docked rail is collapsed, beside the lg-only toggle", async () => {
		act(() => {
			useElenchStore.setState({ railOpen: false });
		});
		renderModal({ isEmpty: false });
		const sheet = await openNarrowRail();
		expect(
			within(sheet).getByRole("button", { name: "Delete chat Audit chat" }),
		).toBeInTheDocument();
	});

	it("closes the sheet after a chat is selected", async () => {
		const h = renderModal({ isEmpty: false });
		const sheet = await openNarrowRail();
		await userEvent.click(within(sheet).getByTestId("thread-rail-row"));
		expect(h.onSelectThread).toHaveBeenCalledWith("t-1");
		await sheetClosed();
	});

	it("reaches Artifacts and Knowledge from the sheet, and can reopen it from either", async () => {
		renderModal({ isEmpty: false });
		await userEvent.click(within(await openNarrowRail()).getByRole("button", { name: "Artifacts" }));
		expect(useElenchStore.getState().mainView).toBe("artifacts");
		await sheetClosed();
		expect(screen.getByText("gallery body")).toBeInTheDocument();

		await userEvent.click(within(await openNarrowRail()).getByRole("button", { name: "Knowledge" }));
		expect(useElenchStore.getState().mainView).toBe("knowledge");
		expect(screen.getByText("knowledge body")).toBeInTheDocument();
		expect(await openNarrowRail()).toBeInTheDocument();
	});
});
