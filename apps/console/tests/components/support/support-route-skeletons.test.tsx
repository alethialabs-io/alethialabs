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
// - case detail: drawn in the shape of the case the request addresses (its messages, attachments and
//   status, read on the server — `case-shape.test.ts` pins the read), in the page's own frames: the
//   thread's frame, bound and column, each message's box with its text sized invisibly inside, the
//   attachments panel, and the composer or the page's own closed notice.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CaseListItem as CaseListItemData, CaseWithThread } from "@/lib/queries/support";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/~/support/my-cases",
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("@/app/server/actions/support", () => ({
	submitCase: vi.fn(),
	postCaseMessage: vi.fn(),
	markCaseRead: vi.fn(async ({ id }: { id: string }) => ({ ok: true, data: { id } })),
	resolveCase: vi.fn(),
	reopenCase: vi.fn(),
	closeCase: vi.fn(),
}));
vi.mock("@/components/classification/classification-control", () => ({ ClassificationControl: () => null }));
// The case route's loading form reads the case's shape on the server (`case-shape.test.ts`).
const { readCaseShape } = vi.hoisted(() => ({ readCaseShape: vi.fn() }));
vi.mock("@/components/support/cases/read-case-shape", () => ({ readCaseShape }));
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
import { CaseDetail } from "@/components/support/cases/case-detail";
import { CASE_THREAD_CONTENT, CASE_THREAD_VIEWPORT } from "@/components/support/cases/case-detail-parts";
import { CaseDetailSkeleton } from "@/components/support/cases/case-detail-skeleton";
import { type CaseShape, OPENING_CASE_SHAPE } from "@/components/support/cases/case-shape";
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
	it("abuse, submit and case detail each render their page's skeleton", async () => {
		expect(elementOf(ReportAbuseLoading()).type).toBe(AbuseFormSkeleton);
		// The case route's draws the shape of the case it read, not a fixed one.
		const shape: CaseShape = { closed: true, attachments: 2, messages: [] };
		readCaseShape.mockResolvedValueOnce(shape);
		const caseLoading = elementOf(await CaseDetailLoading());
		expect(caseLoading.type).toBe(CaseDetailSkeleton);
		expect(caseLoading.props.shape).toBe(shape);
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


describe("~/support/cases/[id]: the skeleton draws THIS case's shape in the page's frames (#6354, B2)", () => {
	const CASE = "11111111-1111-4111-8111-111111111111";
	const AT = new Date("2026-10-19T08:00:00.000Z");

	/** A case read: `status`, a requester message and a staff reply, and `attachments` files. */
	function caseRead(status: CaseWithThread["case"]["status"], attachments = 0): CaseWithThread {
		return {
			case: {
				id: CASE,
				case_number: 2,
				user_id: "user-1",
				org_id: "org-1",
				type: "technical",
				category: "other",
				severity: "normal",
				status,
				subject: "Runner cannot reach the registry",
				context: {},
				contact: { notifyEmail: "a@example.test", channel: "email" },
				abuse: null,
				assigned_staff_id: null,
				last_message_at: AT,
				last_author_type: "staff",
				resolved_at: null,
				closed_at: status === "closed" ? AT : null,
				created_at: AT,
				updated_at: AT,
			},
			messages: [
				{ id: "m1", case_id: CASE, author_type: "customer", author_id: null, author_name: null, body: "It times out.\n\nSince Monday.", created_at: AT },
				{ id: "m2", case_id: CASE, author_type: "staff", author_id: null, author_name: null, body: "Looking into it.", created_at: AT },
			],
			attachments: Array.from({ length: attachments }, (_, i) => ({
				id: `a${i}`,
				case_id: CASE,
				message_id: null,
				uploaded_by: "user-1",
				file_name: `log-${i}.txt`,
				content_type: "text/plain",
				size_bytes: 2048,
				storage_key: `support/org-1/${CASE}/a${i}/log-${i}.txt`,
				created_at: AT,
			})),
		};
	}

	/** The shape `readCaseShape` makes of `read` (the read itself is pinned in `case-shape.test.ts`). */
	function shapeOf(read: CaseWithThread): CaseShape {
		return {
			closed: read.case.status === "closed",
			attachments: read.attachments.length,
			messages: [
				{ fromCustomer: true, paragraphs: ["It times out.", "Since Monday."] },
				{ fromCustomer: false, paragraphs: ["Looking into it."] },
			],
		};
	}

	/** The real case view over `read`, settled. */
	async function page(read: CaseWithThread): Promise<Element[]> {
		const key = orpc.support.case.queryOptions({ input: { id: CASE } }).queryKey;
		const { container } = renderWithClient(<CaseDetail caseId={CASE} orgSlug="acme" />, (qc) => qc.setQueryData(key, read));
		await act(async () => {});
		return kids(container.firstElementChild);
	}

	/** The skeleton's top-level parts for `shape`. */
	const skeleton = (shape?: CaseShape) => kids(render(<CaseDetailSkeleton shape={shape} />).container.firstElementChild);

	/** The thread frame's viewport and message column. */
	function threadParts(frame: Element | undefined) {
		const viewport = frame?.firstElementChild ?? null;
		return { viewport, column: viewport?.firstElementChild ?? null };
	}

	it("draws the classification row under the heading — the 38px the thread sat too high", () => {
		const lead = kids(skeleton()[0])[1];
		// The heading row, then the `size="sm"` Classify button's 32px.
		expect(kids(lead)).toHaveLength(2);
		expect(classes(kids(lead)[1])).toContain("h-8");
	});

	it("knowing nothing, draws the one message every case opens with: the requester's, one line", () => {
		expect(skeleton()).toHaveLength(3);
		const { column } = threadParts(skeleton(OPENING_CASE_SHAPE)[1]);
		expect(kids(column)).toHaveLength(1);
		const [label, bubble] = kids(kids(column)[0]);
		expect(classes(kids(column)[0])).toContain("ml-auto");
		expect(kids(label)).toHaveLength(2);
		expect(classes(bubble)).toEqual(expect.arrayContaining(["w-1/2", "px-4", "py-3"]));
		expect(bubble?.querySelectorAll("p")).toHaveLength(1);
	});

	it("draws the thread in the page's frame, with the page's viewport bound and message column", async () => {
		const read = caseRead("open");
		const real = (await page(read))[1];
		const sk = skeleton(shapeOf(read))[1];
		expect(classes(sk)).toEqual(classes(real));
		const viewport = real?.querySelector('[data-slot="message-scroller-viewport"]');
		const column = real?.querySelector('[data-slot="message-scroller-content"]');
		const parts = threadParts(sk);
		for (const token of CASE_THREAD_VIEWPORT.split(" ")) {
			expect(classes(viewport)).toContain(token);
			expect(classes(parts.viewport)).toContain(token);
		}
		for (const token of ["flex", "flex-col", "gap-8", ...CASE_THREAD_CONTENT.split(" ")]) {
			expect(classes(column)).toContain(token);
			expect(classes(parts.column)).toContain(token);
		}
		// Bounded and opening at the end, as the page's scroller does: a long thread is clipped at the top.
		expect(classes(parts.viewport)).toEqual(expect.arrayContaining(["overflow-hidden", "justify-end"]));
	});

	it("draws one message per message, each in the page's message box, its text sized inside", async () => {
		const read = caseRead("open");
		const real = (await page(read))[1];
		const realMessages = Array.from(real?.querySelectorAll("[data-message-id]") ?? []).map((item) => item.firstElementChild);
		const skMessages = kids(threadParts(skeleton(shapeOf(read))[1]).column);
		expect(skMessages).toHaveLength(realMessages.length);
		expect(skMessages).toHaveLength(2);

		// The column: `w-full max-w-[95%]`, a `gap-2` stack, right-aligned for the requester only.
		for (const [i, message] of realMessages.entries()) {
			for (const token of ["flex", "w-full", "min-w-0", "max-w-[95%]", "flex-col", "gap-2"]) {
				expect(classes(message)).toContain(token);
				expect(classes(skMessages[i])).toContain(token);
			}
			expect(classes(skMessages[i]).includes("ml-auto")).toBe(classes(message).includes("ml-auto"));
		}
		expect(classes(realMessages[0])).toContain("ml-auto");

		// The body box: `w-fit max-w-full text-sm`; the requester's bubble pads `px-4 py-3`.
		const realBodies = realMessages.map((m) => kids(m)[1]);
		const skBodies = skMessages.map((m) => kids(m)[1]);
		for (const [i, body] of realBodies.entries()) {
			for (const token of ["w-fit", "max-w-full", "text-sm"]) {
				expect(classes(body)).toContain(token);
				expect(classes(skBodies[i])).toContain(token);
			}
		}
		expect(classes(realBodies[0])).toEqual(expect.arrayContaining(["group-[.is-user]:px-4", "group-[.is-user]:py-3"]));
		expect(classes(skBodies[0])).toEqual(expect.arrayContaining(["px-4", "py-3"]));
		expect(classes(skBodies[1])).not.toContain("px-4");

		// The staff reply's label row starts with its 24px avatar; the requester's has none.
		expect(classes(kids(kids(realMessages[1])[0])[0])).toContain("size-6");
		expect(classes(kids(kids(skMessages[1])[0])[0])).toContain("size-6");
		expect(kids(kids(skMessages[0])[0])).toHaveLength(2);

		// The text, invisibly, in the blocks its markdown renders as, spaced as the renderer spaces them.
		await vi.waitFor(() => expect(classes(realBodies[0]?.firstElementChild)).toEqual(expect.arrayContaining(["space-y-4", "whitespace-normal"])));
		const sizer = skBodies[0]?.firstElementChild;
		expect(classes(sizer)).toEqual(expect.arrayContaining(["invisible", "space-y-4", "whitespace-normal"]));
		expect(Array.from(sizer?.querySelectorAll("p") ?? []).map((p) => p.textContent)).toEqual(["It times out.", "Since Monday."]);
	});

	it("draws the attachments panel, row for row, when the case has attachments", async () => {
		const read = caseRead("open", 3);
		const real = await page(read);
		const sk = skeleton(shapeOf(read));
		expect(sk).toHaveLength(real.length);
		expect(sk).toHaveLength(4);
		expect(classes(sk[1])).toEqual(classes(real[1]));
		expect(classes(kids(sk[1])[0])).toEqual(classes(kids(real[1])[0]));
		expect(classes(kids(sk[1])[1])).toEqual(classes(kids(real[1])[1]));
		expect(kids(kids(sk[1])[1])).toHaveLength(3);
		expect(kids(kids(real[1])[1])).toHaveLength(3);
	});

	it("draws the composer with the composer's own spacing and the reply box at its floor", () => {
		const composer = renderWithClient(<CaseComposer caseId="c1" />).container.querySelector("form");
		const sk = skeleton()[2];
		expect(classes(sk)).toEqual(classes(composer));
		expect(classes(composer?.querySelector("textarea"))).toContain("min-h-24");
		expect(classes(kids(sk)[0])).toContain("h-24");
	});

	it("on a closed case, draws the page's own closed notice where the composer goes, and no lifecycle button", async () => {
		const read = caseRead("closed");
		const real = await page(read);
		const sk = skeleton(shapeOf(read));
		const notice = sk.at(-1);
		expect(classes(notice)).toEqual(classes(real.at(-1)));
		expect(notice?.textContent).toContain("This case is closed");
		expect(notice?.querySelector("textarea")).toBeNull();
		// The heading row holds the subject column alone: the page puts the one action in the notice.
		expect(kids(kids(kids(sk[0])[1])[0])).toHaveLength(1);
		expect(kids(kids(kids(skeleton()[0])[1])[0])).toHaveLength(2);
	});
});
