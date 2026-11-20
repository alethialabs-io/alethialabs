// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The changeset bar (#6833). It is on the board in every state, it says where the design stands,
// and its one way forward is Review plan. It has no Deploy: a deploy is offered only in the review
// view, behind a plan. Save is offered only while the board's host still has a save of its own.
//
// One test per state of the bar, then the things a person does with it: discard (asked first),
// open and close the review, reach everything from the keyboard.

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
	EMPTY_ENVIRONMENT_STATUS,
	type EnvironmentStatus,
	type ReviewPlan,
} from "@/lib/canvas/component-status";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import { board } from "@/lib/canvas/store/board";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";
import { queryWrapper } from "@/tests/helpers/query-wrapper";

const h = vi.hoisted(() => {
	const handlers: Record<string, FakeHandler> = {};
	const calls: FakeCall[] = [];
	return { handlers, calls };
});
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});
vi.mock("next/navigation", () => ({ useParams: () => ({ org: "acme" }) }));
// The review view's writes are review-view.test.tsx's subject; nothing here presses them.
vi.mock("@/app/server/actions/canvas-writes", () => ({
	saveDesignAction: vi.fn(),
	planEnvironmentAction: vi.fn(),
}));
vi.mock("@/app/server/actions/jobs", () => ({ applyPlan: vi.fn() }));

const { PendingChangesBar } = await import(
	"@/components/design-project/canvas/pending-changes-bar"
);

const PROJECT = "5f0c1f3a-2b1e-4c6d-9a8b-7c6d5e4f3a2b";
const ENVIRONMENT = "6a1d2e4b-3c2f-4d7e-8b9c-8d7e6f5a4b3c";

const NO_PLAN: ReviewPlan = {
	environmentId: ENVIRONMENT,
	planJobId: null,
	status: null,
	createdAt: null,
	summary: null,
	cost: null,
	designRevision: null,
	savedRevision: "0",
	digest: null,
	current: false,
	staleReason: "no-plan",
};

/** The bar on a board whose environment status is `status`. */
function renderBar(status: Partial<EnvironmentStatus> = {}, props: { onDiscard?: () => void } = {}) {
	const Wrapper = queryWrapper();
	const tree = (children: ReactNode) => (
		<Wrapper>
			<EnvironmentStatusProvider
				value={{
					...EMPTY_ENVIRONMENT_STATUS,
					environment: { id: ENVIRONMENT, name: "production", stage: "production", status: "ACTIVE" },
					...status,
				}}
			>
				{children}
			</EnvironmentStatusProvider>
		</Wrapper>
	);
	return render(tree(<PendingChangesBar projectId={PROJECT} {...props} />));
}

/** The bar itself, whichever state it is in. */
function bar() {
	return screen.getByRole("group", { name: "Changes and deploy" });
}

/** Stage one design change: a new database. */
function stageOneChange() {
	useCanvasStore.getState().addNode("database");
}

beforeEach(() => {
	useCanvasStore.getState().reset();
	h.calls.length = 0;
	h.handlers["canvas.reviewPlan"] = async () => NO_PLAN;
});

describe("PendingChangesBar: one render per state", () => {
	it("edits pending: says how many and what kind, offers Discard and Review plan", () => {
		stageOneChange();
		renderBar();
		expect(bar()).toHaveAttribute("data-state", "pending");
		expect(bar()).toHaveAttribute("data-testid", "pending-changes-bar");
		expect(within(bar()).getByText("Pending changes")).toBeInTheDocument();
		expect(within(bar()).getByText("1 added")).toBeInTheDocument();
		expect(within(bar()).getByRole("button", { name: "Discard" })).toBeEnabled();
		expect(within(bar()).getByRole("button", { name: "Review plan" })).toBeEnabled();
	});

	it("clean and never deployed: the bar is still there, and Review plan is enabled", () => {
		renderBar({ deployState: "never" });
		expect(bar()).toHaveAttribute("data-state", "never");
		expect(within(bar()).getByText("Not deployed yet")).toBeInTheDocument();
		expect(within(bar()).getByRole("button", { name: "Review plan" })).toBeEnabled();
		expect(within(bar()).queryByRole("button", { name: "Discard" })).toBeNull();
	});

	it("clean, saved ahead of deployed: Review plan is enabled", () => {
		renderBar({ deployState: "ahead", updatePending: true });
		expect(bar()).toHaveAttribute("data-state", "ahead");
		expect(within(bar()).getByText("Saved, not deployed")).toBeInTheDocument();
		expect(within(bar()).getByRole("button", { name: "Review plan" })).toBeEnabled();
	});

	it("clean and in sync", () => {
		renderBar({ deployState: "in-sync" });
		expect(bar()).toHaveAttribute("data-state", "in-sync");
		expect(within(bar()).getByText("Up to date")).toBeInTheDocument();
		expect(within(bar()).getByRole("button", { name: "Review plan" })).toBeEnabled();
	});

	it("a job running: says what it is doing and links to its log", () => {
		renderBar({ activeJob: { id: "job-1", type: "DEPLOY", status: "PROCESSING" } });
		expect(bar()).toHaveAttribute("data-state", "running");
		expect(within(bar()).getByText("Deploying")).toBeInTheDocument();
		expect(within(bar()).getByRole("link", { name: "View log" })).toHaveAttribute(
			"href",
			"/acme/~/jobs?job=job-1",
		);
	});

	it("a deploy queued and not started reads as waiting", () => {
		renderBar({ activeJob: { id: "job-1", type: "DEPLOY", status: "QUEUED" } });
		expect(within(bar()).getByText("Deploy queued, waiting to start")).toBeInTheDocument();
	});

	it("the last deploy failed: says so, links to its log, and offers Review plan", () => {
		renderBar({
			deployState: "ahead",
			recentJobs: [
				{ id: "job-9", type: "DEPLOY", status: "FAILED", createdAt: "2026-11-20T09:00:00.000Z" },
			],
		});
		expect(bar()).toHaveAttribute("data-state", "failed");
		expect(within(bar()).getByText("Deploy failed")).toBeInTheDocument();
		expect(within(bar()).getByRole("link", { name: "View log" })).toHaveAttribute(
			"href",
			"/acme/~/jobs?job=job-9",
		);
		expect(within(bar()).getByRole("button", { name: "Review plan" })).toBeEnabled();
	});

	it("issues in the draft: a button says how many and opens the review", async () => {
		// An unconfigured project has issues of its own (no name, no cloud account).
		renderBar();
		const issues = within(bar()).getByRole("button", { name: /issues? in the design/i });
		await userEvent.setup().click(issues);
		expect(await screen.findByRole("region", { name: "Review and deploy" })).toBeInTheDocument();
		expect(screen.getByRole("region", { name: "Issues to fix before planning" })).toBeInTheDocument();
	});

	it("announces its state: the visible words are the live region", () => {
		renderBar({ deployState: "ahead" });
		expect(within(bar()).getByRole("status")).toHaveTextContent("Saved, not deployed");
	});
});

describe("PendingChangesBar: what it does not do", () => {
	it("has no Deploy, in any state", () => {
		stageOneChange();
		renderBar();
		expect(within(bar()).queryByRole("button", { name: /^Deploy$/ })).toBeNull();
	});

	it("never calls a deploy handler a host may still pass, whatever is pressed", async () => {
		stageOneChange();
		const onDeploy = vi.fn();
		const Wrapper = queryWrapper();
		render(
			<Wrapper>
				<PendingChangesBar projectId={PROJECT} onDeploy={onDeploy} />
			</Wrapper>,
		);
		const user = userEvent.setup();
		for (const button of within(bar()).getAllByRole("button")) {
			if (button.textContent === "Discard") continue;
			await user.click(button);
		}
		expect(onDeploy).not.toHaveBeenCalled();
	});
});

describe("PendingChangesBar: save without planning", () => {
	it("offers Save while the host has one, and calls it", async () => {
		stageOneChange();
		const onSave = vi.fn();
		const Wrapper = queryWrapper();
		render(
			<Wrapper>
				<PendingChangesBar projectId={PROJECT} onSave={onSave} />
			</Wrapper>,
		);
		await userEvent.setup().click(within(bar()).getByRole("button", { name: "Save" }));
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it("has no Save when the host does not pass one, and none on a clean board", () => {
		stageOneChange();
		renderBar();
		expect(within(bar()).queryByRole("button", { name: "Save" })).toBeNull();
	});

	it("does not offer Save when nothing is pending", () => {
		const Wrapper = queryWrapper();
		render(
			<Wrapper>
				<PendingChangesBar projectId={PROJECT} onSave={vi.fn()} />
			</Wrapper>,
		);
		expect(within(bar()).queryByRole("button", { name: "Save" })).toBeNull();
	});
});

describe("PendingChangesBar: discard", () => {
	it("asks first: Cancel keeps the changes, Discard drops them and tells the host", async () => {
		stageOneChange();
		const onDiscard = vi.fn();
		renderBar({}, { onDiscard });
		const user = userEvent.setup();

		await user.click(within(bar()).getByRole("button", { name: "Discard" }));
		const question = await screen.findByRole("alertdialog");
		expect(within(question).getByText("Discard staged changes?")).toBeInTheDocument();
		await user.click(within(question).getByRole("button", { name: "Cancel" }));
		await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(bar()).toHaveAttribute("data-state", "pending");
		expect(onDiscard).not.toHaveBeenCalled();

		await user.click(within(bar()).getByRole("button", { name: "Discard" }));
		await user.click(
			within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }),
		);
		await vi.waitFor(() => expect(bar()).toHaveAttribute("data-state", "never"));
		expect(bar()).toHaveAttribute("data-testid", "changeset-bar");
		expect(onDiscard).toHaveBeenCalledTimes(1);
		expect(board.document.getState().designNodes.some((n) => n.data.kind === "database")).toBe(false);
	});
});

describe("PendingChangesBar: the review view", () => {
	it("Review plan opens the view and moves focus into it; pressing it again closes it", async () => {
		renderBar();
		const user = userEvent.setup();
		const review = within(bar()).getByRole("button", { name: "Review plan" });
		expect(review).toHaveAttribute("aria-expanded", "false");

		await user.click(review);
		const view = await screen.findByRole("region", { name: "Review and deploy" });
		expect(view).toHaveFocus();
		expect(review).toHaveAttribute("aria-expanded", "true");

		await user.click(review);
		expect(screen.queryByRole("region", { name: "Review and deploy" })).toBeNull();
	});

	it("Escape in the view closes it and returns focus to Review plan", async () => {
		renderBar();
		const user = userEvent.setup();
		const review = within(bar()).getByRole("button", { name: "Review plan" });
		await user.click(review);
		await screen.findByRole("region", { name: "Review and deploy" });

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("region", { name: "Review and deploy" })).toBeNull();
		expect(review).toHaveFocus();
	});

	it("is reachable and operable from the keyboard alone", async () => {
		stageOneChange();
		renderBar();
		const user = userEvent.setup();
		const review = within(bar()).getByRole("button", { name: "Review plan" });
		review.focus();
		await user.keyboard("{Enter}");
		expect(await screen.findByRole("region", { name: "Review and deploy" })).toBeInTheDocument();
	});

	it("gives way to the inspector and comes back when the inspector closes", async () => {
		stageOneChange();
		renderBar();
		const user = userEvent.setup();
		await user.click(within(bar()).getByRole("button", { name: "Review plan" }));
		await screen.findByRole("region", { name: "Review and deploy" });

		const node = board.document.getState().designNodes.find((n) => n.data.kind === "database");
		act(() => board.view.getState().setSubject({ kind: "node", id: node?.id ?? "" }));
		expect(screen.queryByRole("region", { name: "Review and deploy" })).toBeNull();

		act(() => board.view.getState().setSubject(null));
		expect(await screen.findByRole("region", { name: "Review and deploy" })).toBeInTheDocument();
	});

	it("says why Review plan is disabled when the board has no project", () => {
		const Wrapper = queryWrapper();
		render(
			<Wrapper>
				<PendingChangesBar />
			</Wrapper>,
		);
		const review = within(bar()).getByRole("button", { name: "Review plan" });
		expect(review).toBeDisabled();
		expect(review).toHaveAccessibleDescription(/not attached to a project/i);
	});
});
