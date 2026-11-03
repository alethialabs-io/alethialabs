// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6354 (B2): the four support routes' skeletons draw the page's own layout, so the swap to the page
// moves nothing. Each test renders the REAL page component beside its skeleton and compares their
// boxes — a skeleton drawn from guessed heights is how all four drifted (the release-gate audit
// measured a 494px skeleton under an 807px abuse form, a 415px row stack over a 139px list, a 350px
// thread panel over a 134px one, and a submit skeleton with no cards under two columns of them).
//
// - abuse: the form's frame, its toolbar copy, its three ruled sections field for field, and the
//   description box's floor;
// - submit: the wizard's frame, the same stepper, step 1's heading and its five type cards in the
//   same grid with the same copy, and the button row;
// - my cases: the answered list is a real `ul`/`li` (an open-ended list, whose bottom edge a
//   skeleton cannot know) whose frame and rows are the skeleton's;
// - case detail: the classification row, ONE opening message, and the composer's own spacing.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CaseListItem as CaseListItemData } from "@/lib/queries/support";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/~/support/my-cases",
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("@/app/server/actions/support", () => ({ submitCase: vi.fn(), postCaseMessage: vi.fn() }));
vi.mock("@/components/support/use-submit-case", () => ({
	useSubmitCase: () => ({ mutate: vi.fn(), isPending: false }),
}));
// Every read stays in flight: the list's rows come from the seeded cache, never from a fetch.
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({ "support.cases": () => new Promise(() => {}) }, []).orpc };
});

import ReportAbuseLoading from "@/app/(private)/[org]/~/support/abuse/loading";
import CaseDetailLoading from "@/app/(private)/[org]/~/support/cases/[id]/loading";
import SubmitCaseLoading from "@/app/(private)/[org]/~/support/submit/loading";
import { AbuseForm, AbuseFormSkeleton } from "@/components/support/abuse/abuse-form";
import { CaseComposer } from "@/components/support/cases/case-composer";
import { CaseDetailSkeleton } from "@/components/support/cases/case-detail-skeleton";
import { CaseList } from "@/components/support/cases/case-list";
import { CASE_ROW, CASE_ROWS } from "@/components/support/cases/case-list-item";
import { CaseListSkeletonRows } from "@/components/support/cases/case-list-skeleton";
import { SubmitCaseForm, SubmitCaseFormSkeleton } from "@/components/support/submit/submit-case-form";
import { orpc } from "@/lib/rpc/client";

/** Renders under a fresh QueryClient, optionally seeded. */
function renderWithClient(ui: ReactElement, seed?: (qc: QueryClient) => void) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
	seed?.(qc);
	const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
	return render(ui, { wrapper });
}

/** The class tokens of an element. */
function classes(el: Element | null | undefined): string[] {
	return (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** The element children of an element, as an array. */
function kids(el: Element | null | undefined): Element[] {
	return el ? Array.from(el.children) : [];
}

/** The element a route's `loading.tsx` returned, and its props. */
function elementOf(node: unknown): ReactElement<Record<string, unknown>> {
	if (typeof node !== "object" || node === null || !isValidElement<Record<string, unknown>>(node)) {
		throw new Error("not an element");
	}
	return node;
}

describe("the support routes' loading.tsx draw the pages' own loading forms (#6354)", () => {
	it("abuse, submit and case detail each render their page's skeleton", () => {
		expect(elementOf(ReportAbuseLoading()).type).toBe(AbuseFormSkeleton);
		expect(elementOf(CaseDetailLoading()).type).toBe(CaseDetailSkeleton);
		// The submit page wraps its form in `max-w-2xl`; the skeleton sits in the same column.
		const submit = elementOf(SubmitCaseLoading());
		expect(submit.props.className).toBe("max-w-2xl");
		expect(elementOf(submit.props.children).type).toBe(SubmitCaseFormSkeleton);
	});
});

describe("~/support/abuse: the skeleton is the form's layout (#6354, B2)", () => {
	const real = () => render(<AbuseForm orgSlug="acme" defaultEmail="a@example.test" />).container.querySelector("form");
	const skeleton = () => render(<AbuseFormSkeleton />).container.firstElementChild;

	it("has the form's frame and its five parts, each in the part's own box", () => {
		const form = real();
		const sk = skeleton();
		expect(classes(sk)).toEqual(classes(form));
		// The toolbar, the three sections (two of them ruled), the submit row.
		expect(kids(sk)).toHaveLength(5);
		expect(kids(sk).map((c) => classes(c))).toEqual(kids(form).map((c) => classes(c)));
	});

	it("carries the toolbar's real copy, so it wraps where the page's does", () => {
		const copy = (root: Element | null) => root?.querySelector('[data-slot="page-toolbar-description"]')?.textContent;
		expect(copy(skeleton())).toBeTruthy();
		expect(copy(skeleton())).toBe(copy(real()));
	});

	it("draws every section field for field: the controls, the hint and the reserved message lines", () => {
		const form = real();
		const sk = skeleton();
		for (let i = 1; i <= 3; i++) {
			const r = kids(form)[i];
			const s = kids(sk)[i];
			expect(kids(s), `section ${i}'s field count`).toHaveLength(kids(r).length);
			expect(s.querySelectorAll('[data-slot="field-message"]').length, `section ${i}'s message lines`).toBe(
				r.querySelectorAll('[data-slot="field-message"]').length,
			);
		}
		// The one-line controls: every input and select trigger is a 36px (`h-9`) placeholder.
		const controls = form?.querySelectorAll('[data-slot="input"], [data-slot="select-trigger"]').length ?? 0;
		expect(controls).toBe(5);
		expect(sk?.querySelectorAll('[data-slot="skeleton"].h-9.w-full').length).toBe(controls);
		// The resource field's hint line.
		expect(kids(kids(sk)[1])[1].querySelector(".h-4")).not.toBeNull();
	});

	it("draws the description box at the textarea's floor", () => {
		expect(classes(real()?.querySelector("textarea"))).toContain("min-h-40");
		expect(skeleton()?.querySelectorAll('[data-slot="skeleton"].h-40')).toHaveLength(1);
	});
});

describe("~/support/submit: the skeleton is the wizard's first step (#6354, B2)", () => {
	const real = () =>
		renderWithClient(<SubmitCaseForm orgSlug="acme" defaultEmail="a@example.test" />).container.firstElementChild;
	const skeleton = () => render(<SubmitCaseFormSkeleton />).container.firstElementChild;

	it("has the wizard's frame and the same stepper", () => {
		const form = real();
		const sk = skeleton();
		expect(classes(sk)).toEqual(classes(form));
		expect(sk?.querySelector("nav")?.outerHTML).toBe(form?.querySelector("nav")?.outerHTML);
	});

	it("draws step 1's heading and one card per case type, in the same grid with the same copy", () => {
		const form = real();
		const sk = skeleton();
		expect(sk?.querySelector("h2")?.textContent).toBe(form?.querySelector("h2")?.textContent);

		const cards = Array.from(form?.querySelectorAll("button[aria-pressed]") ?? []);
		const placeholders = Array.from(sk?.querySelectorAll('[data-slot="radio-card-skeleton"]') ?? []);
		expect(cards).toHaveLength(5);
		expect(placeholders).toHaveLength(cards.length);
		// Two columns from `sm`, as the page draws them — the audit read two columns over none.
		expect(classes(placeholders[0].parentElement)).toEqual(classes(cards[0].parentElement));
		expect(classes(placeholders[0].parentElement)).toContain("sm:grid-cols-2");
		placeholders.forEach((p, i) => {
			expect(p.textContent, `card ${i}'s copy`).toBe(cards[i].textContent);
			// The card's box: every layout token of the placeholder is the card's.
			for (const token of classes(p).filter((t) => t !== "border-border")) {
				expect(classes(cards[i]), `card ${i} carries ${token}`).toContain(token);
			}
		});
	});

	it("ends in the button row, with the empty Back slot and a Continue-sized placeholder", () => {
		const form = real();
		const sk = skeleton();
		const row = Array.from(form?.querySelectorAll("button") ?? []).find((b) => b.textContent === "Continue")?.parentElement;
		const skRow = sk?.lastElementChild?.lastElementChild;
		expect(classes(skRow)).toEqual(classes(row));
		expect(kids(skRow)).toHaveLength(kids(row).length);
		expect(classes(kids(skRow)[1])).toContain("h-9");
	});
});

describe("~/support/my-cases: the answered list is a list, in the skeleton's frame (#6354, B2)", () => {
	const item = (id: string, case_number: number, subject: string): CaseListItemData => ({
		id,
		case_number,
		subject,
		type: "technical",
		category: "runners",
		severity: "normal",
		status: "open",
		last_message_at: new Date("2026-10-09T08:00:00.000Z"),
		last_author_type: "customer",
		created_at: new Date("2026-10-09T08:00:00.000Z"),
		unread: false,
		requester_name: null,
		is_mine: true,
	});

	it("renders the cases as `ul > li` rows, framed and ruled as the skeleton's rows are", async () => {
		const { container } = renderWithClient(<CaseList orgSlug="acme" seeAll={false} />, (qc) =>
			qc.setQueryData(orpc.support.cases.queryOptions({ input: { bucket: "all" } }).queryKey, [
				item("c1", 1042, "Runner cannot reach the registry"),
				item("c2", 1043, "Invoice address is wrong"),
			]),
		);
		await act(async () => {});
		const list = container.querySelector("ul");
		expect(list).not.toBeNull();
		expect(kids(list).map((li) => li.tagName)).toEqual(["LI", "LI"]);
		expect(classes(list)).toEqual(CASE_ROWS.split(" "));
		for (const li of kids(list)) expect(classes(li.firstElementChild)).toEqual(expect.arrayContaining(CASE_ROW.split(" ")));

		const sk = render(<CaseListSkeletonRows />).container.firstElementChild;
		expect(classes(sk)).toEqual(classes(list));
		for (const row of kids(sk)) expect(classes(row)).toEqual(CASE_ROW.split(" "));
	});
});

describe("~/support/cases/[id]: the skeleton draws the case's shape (#6354, B2)", () => {
	const skeleton = () => render(<CaseDetailSkeleton />).container.firstElementChild;

	it("draws the classification row under the heading — the 38px the thread sat too high", () => {
		const header = kids(skeleton())[0];
		const lead = kids(header)[1];
		// The heading row, then the `size="sm"` Classify button's 32px.
		expect(kids(lead)).toHaveLength(2);
		expect(classes(kids(lead)[1])).toContain("h-8");
	});

	it("draws ONE opening message in the bordered thread, not three", () => {
		const thread = kids(skeleton())[1];
		expect(classes(thread)).toEqual(expect.arrayContaining(["rounded-md", "border"]));
		expect(kids(thread)).toHaveLength(1);
		// The requester's own message: right-aligned.
		expect(classes(kids(thread)[0])).toContain("ml-auto");
	});

	it("draws the composer with the composer's own spacing and the reply box at its floor", () => {
		const composer = renderWithClient(<CaseComposer caseId="c1" />).container.querySelector("form");
		const sk = kids(skeleton())[2];
		expect(classes(sk)).toEqual(classes(composer));
		expect(classes(composer?.querySelector("textarea"))).toContain("min-h-24");
		expect(classes(kids(sk)[0])).toContain("h-24");
	});
});
