// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The case thread's scroll policy (#6143, kept from #6130): a reply that lands while the viewer is
// at the bottom is followed; one that lands while they are reading history does NOT move them; and
// their own send scrolls to it wherever they were.
//
// The thread renders through the real `message-scroller` primitive. jsdom has no layout, so the
// viewport is given one: every message is ROW px tall, the viewport VIEW px, and `scrollTop` is a
// real clamped value the primitive reads back. The own-send case drives the REAL composer inside
// the real case view, because "own send" is recognised by the id the composer's optimistic patch
// gives the reply — a test that hand-wrote that id would pass after the composer changed it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseWithThread, PublicMessage } from "@/lib/queries/support";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/server/actions/support", () => ({
	markCaseRead: vi.fn(async ({ id }: { id: string }) => ({ ok: true, data: { id } })),
	// The send stays in flight, so the optimistic reply is what the thread shows.
	postCaseMessage: vi.fn(() => new Promise(() => {})),
	resolveCase: vi.fn(),
	reopenCase: vi.fn(),
	closeCase: vi.fn(),
}));
vi.mock("@/components/classification/classification-control", () => ({ ClassificationControl: () => null }));
// The markdown stack is not what is under test; the bubble's text is enough.
vi.mock("@/components/ai-elements/message", () => ({
	Message: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	MessageContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	MessageResponse: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { CaseDetail } from "@/components/support/cases/case-detail";
import { caseKey } from "@/components/support/cases/case-queries";
import { CaseThread } from "@/components/support/cases/case-thread";

const CASE = "11111111-1111-4111-8111-111111111111";
const ROW = 100;
const VIEW = 300;
const AT = new Date("2026-10-19T08:00:00.000Z");

/** `n` alternating customer/staff messages, oldest first. */
function thread(n: number): PublicMessage[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `m${i}`,
		case_id: CASE,
		author_type: i % 2 === 0 ? "customer" : "staff",
		author_id: null,
		author_name: null,
		body: `message ${i}`,
		created_at: AT,
	}));
}

/** A staff reply, as the bus-driven refetch delivers it. */
function staffReply(id: string): PublicMessage {
	return { id, case_id: CASE, author_type: "staff", author_id: null, author_name: null, body: "reply", created_at: AT };
}

/** True for the scroller's viewport element. */
function isViewport(el: Element): boolean {
	return el instanceof HTMLElement && el.dataset.slot === "message-scroller-viewport";
}

/** The rendered message rows, in order. */
function rows(viewport: Element): HTMLElement[] {
	return Array.from(viewport.querySelectorAll<HTMLElement>("[data-message-id]"));
}

const scrollTops = new WeakMap<Element, number>();
const saved = new Map<string, PropertyDescriptor | undefined>();

/** Gives jsdom a fixed geometry for the scroller: ROW-px rows in a VIEW-px viewport. */
function installLayout() {
	const proto = HTMLElement.prototype;
	for (const k of ["scrollTop", "scrollHeight", "clientHeight", "getBoundingClientRect", "scrollTo"]) {
		saved.set(k, Object.getOwnPropertyDescriptor(proto, k));
	}
	const maxTop = (el: Element) => Math.max(0, rows(el).length * ROW - VIEW);
	Object.defineProperty(proto, "scrollTop", {
		configurable: true,
		get(this: HTMLElement) {
			return scrollTops.get(this) ?? 0;
		},
		set(this: HTMLElement, v: number) {
			scrollTops.set(this, isViewport(this) ? Math.min(Math.max(0, v), maxTop(this)) : 0);
		},
	});
	Object.defineProperty(proto, "scrollHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return isViewport(this) ? Math.max(VIEW, rows(this).length * ROW) : 0;
		},
	});
	Object.defineProperty(proto, "clientHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return isViewport(this) ? VIEW : 0;
		},
	});
	Object.defineProperty(proto, "getBoundingClientRect", {
		configurable: true,
		value(this: HTMLElement) {
			if (isViewport(this)) return DOMRect.fromRect({ x: 0, y: 0, width: 600, height: VIEW });
			const viewport = this.closest("[data-slot='message-scroller-viewport']");
			const index = viewport && this.dataset.messageId ? rows(viewport).indexOf(this) : -1;
			if (!viewport || index < 0) return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
			return DOMRect.fromRect({ x: 0, y: index * ROW - viewport.scrollTop, width: 600, height: ROW });
		},
	});
	Object.defineProperty(proto, "scrollTo", {
		configurable: true,
		value(this: HTMLElement, opts: ScrollToOptions) {
			this.scrollTop = opts.top ?? this.scrollTop;
			this.dispatchEvent(new Event("scroll"));
		},
	});
}

/** Restores the prototype members `installLayout` replaced. */
function removeLayout() {
	for (const [k, d] of saved) {
		if (d) Object.defineProperty(HTMLElement.prototype, k, d);
		else Reflect.deleteProperty(HTMLElement.prototype, k);
	}
	saved.clear();
}

/** The thread's viewport. */
function viewport(): HTMLElement {
	const el = document.querySelector("[data-slot='message-scroller-viewport']");
	if (!(el instanceof HTMLElement) || !isViewport(el)) throw new Error("no viewport");
	return el;
}

/** The viewer scrolls up to the top of the thread, as a wheel gesture does. */
function readHistory() {
	const vp = viewport();
	fireEvent.wheel(vp, { deltaY: -500 });
	vp.scrollTop = 0;
	fireEvent.scroll(vp);
}

/** Lets the content MutationObserver and the primitive's animation frames run. */
async function settle() {
	await act(async () => {
		await new Promise((r) => setTimeout(r, 50));
	});
}

beforeEach(() => {
	installLayout();
	vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
	removeLayout();
	vi.unstubAllGlobals();
});

describe("CaseThread — scrolling", () => {
	it("opens at the newest message", async () => {
		render(<CaseThread messages={thread(5)} />);
		await settle();
		expect(viewport().scrollTop).toBe(5 * ROW - VIEW);
	});

	it("follows a new reply when the viewer is at the bottom", async () => {
		const { rerender } = render(<CaseThread messages={thread(5)} />);
		await settle();
		expect(viewport().scrollTop).toBe(5 * ROW - VIEW);

		rerender(<CaseThread messages={[...thread(5), staffReply("s1")]} />);
		await waitFor(() => expect(viewport().scrollTop).toBe(6 * ROW - VIEW));
	});

	it("does NOT move a viewer who has scrolled up to read history", async () => {
		const { rerender } = render(<CaseThread messages={thread(5)} />);
		await settle();
		readHistory();
		await settle();
		expect(viewport().scrollTop).toBe(0);

		rerender(<CaseThread messages={[...thread(5), staffReply("s1")]} />);
		await settle();
		expect(viewport().scrollTop).toBe(0);
	});
});

describe("CaseDetail — the viewer's own send", () => {
	it("scrolls the thread to the reply even when the viewer had scrolled up", async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
		const read: CaseWithThread = {
			case: {
				id: CASE,
				case_number: 2,
				user_id: "user-1",
				org_id: "org-1",
				type: "technical",
				category: "other",
				severity: "normal",
				status: "open",
				subject: "Runner cannot reach the registry",
				context: {},
				contact: { notifyEmail: "a@example.test", channel: "email" },
				abuse: null,
				assigned_staff_id: null,
				last_message_at: AT,
				last_author_type: "customer",
				resolved_at: null,
				closed_at: null,
				created_at: AT,
				updated_at: AT,
			},
			messages: thread(5),
			attachments: [],
		};
		qc.setQueryData(caseKey(CASE), read);
		render(
			<QueryClientProvider client={qc}>
				<CaseDetail caseId={CASE} orgSlug="acme" />
			</QueryClientProvider>,
		);
		await settle();
		readHistory();
		await settle();
		expect(viewport().scrollTop).toBe(0);

		fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), { target: { value: "any update?" } });
		fireEvent.click(await screen.findByRole("button", { name: /send/i }));

		await screen.findByText("any update?", { selector: "div" });
		await waitFor(() => expect(viewport().scrollTop).toBe(6 * ROW - VIEW));
	});
});
