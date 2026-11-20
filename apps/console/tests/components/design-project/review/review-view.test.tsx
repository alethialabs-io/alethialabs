// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The review-and-deploy view (#6833), driven the way a person drives it.
//
// What is pinned:
//   - Run plan saves the design FIRST, then queues the plan, and only then is the baseline
//     committed and the plan recorded;
//   - Deploy is enabled for one situation only — a plan recorded here that the server calls
//     current, with nothing pending — and it applies that plan's id and nothing else;
//   - every other situation leaves Deploy disabled WITH its reason on screen and the action that
//     removes it: no plan, plan failed, design changed (saved or unsaved), something ran since,
//     cloud not available, a current plan nobody confirmed;
//   - a queued deploy that has not started is shown as waiting, with where to look;
//   - a plan that destroys something is deployed only after the environment's name is typed;
//   - one row's Discard reverts that change and no other;
//   - an issue is told in words, and its Go to opens the card on the field.
//
// The server actions and the validator are stubs; the board's stores, the changeset sink, the
// mutation contract and the gate are real.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	EMPTY_ENVIRONMENT_STATUS,
	type EnvironmentStatus,
	type ReviewPlan,
} from "@/lib/canvas/component-status";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import { configName } from "@/components/design-project/canvas/graph/node-config";
import { board } from "@/lib/canvas/store/board";
import { diffNodes } from "@/lib/canvas/store/derive";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => {
	const handlers: Record<string, FakeHandler> = {};
	const calls: FakeCall[] = [];
	return { handlers, calls };
});
const m = vi.hoisted(() => ({
	save: vi.fn(),
	plan: vi.fn(),
	apply: vi.fn(),
	/** What the validator answers. Replaced by a test that wants issues. */
	parse: { result: { success: true, data: {} } as unknown },
}));

vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});
vi.mock("next/navigation", () => ({ useParams: () => ({ org: "acme" }) }));
vi.mock("@/app/server/actions/canvas-writes", () => ({
	saveDesignAction: (...args: unknown[]) => m.save(...args),
	planEnvironmentAction: (...args: unknown[]) => m.plan(...args),
}));
vi.mock("@/app/server/actions/jobs", () => ({
	applyPlan: (...args: unknown[]) => m.apply(...args),
}));
// The graph → form step and the schema are their own tests' subjects (and review-issues.test.ts
// runs the real ones); here a design is valid unless a test says otherwise.
vi.mock("@/lib/validations/project-form.schema", () => ({
	projectFormSchema: { safeParse: () => m.parse.result },
}));
vi.mock("@/components/design-project/canvas/graph/graph-to-form", () => ({
	graphToForm: () => ({}),
}));

const { ReviewView } = await import("@/components/design-project/canvas/review/review-view");
const { TOPIC_KEYS } = await import("@/lib/query/topics");

const PROJECT = "5f0c1f3a-2b1e-4c6d-9a8b-7c6d5e4f3a2b";
const ENVIRONMENT = "6a1d2e4b-3c2f-4d7e-8b9c-8d7e6f5a4b3c";
const PLAN = "11111111-1111-4111-8111-111111111111";
const SCOPE = { projectId: PROJECT, environmentId: ENVIRONMENT, environmentName: "production" };

/** A server answer for a successful, current plan, with overrides. */
function serverPlan(over: Partial<ReviewPlan> = {}): ReviewPlan {
	return {
		environmentId: ENVIRONMENT,
		planJobId: PLAN,
		status: "SUCCESS",
		createdAt: "2026-11-20T10:00:00.000Z",
		summary: { create: 2, update: 1, delete: 0, replace: 0 },
		cost: { totalMonthly: 212.4, currency: "EUR" },
		designRevision: "7",
		savedRevision: "7",
		digest: null,
		current: true,
		staleReason: null,
		...over,
	};
}

const NO_PLAN = serverPlan({
	planJobId: null,
	status: null,
	createdAt: null,
	summary: null,
	cost: null,
	designRevision: null,
	current: false,
	staleReason: "no-plan",
});

/** One entry of a stored plan result. */
function resource(address: string, actions: string[]) {
	const [type, name] = address.split(".");
	return { address, type, name, change: { actions, after: {}, after_unknown: {} } };
}

let client: QueryClient;
/** What `canvas.reviewPlan` answers right now. */
let answer: ReviewPlan;
/** What `jobs.planResult` answers right now. */
let planResult: {
	status: string;
	job_type: string;
	error_message: string | null;
	execution_metadata: { plan_result?: Record<string, unknown> } | null;
};

/** Renders the view on a board whose environment status is `status`. */
function renderView(status: Partial<EnvironmentStatus> = {}) {
	const onClose = vi.fn();
	render(
		<QueryClientProvider client={client}>
			<EnvironmentStatusProvider
				value={{
					...EMPTY_ENVIRONMENT_STATUS,
					environment: { id: ENVIRONMENT, name: "production", stage: "production", status: "ACTIVE" },
					...status,
				}}
			>
				<ReviewView scope={SCOPE} onClose={onClose} />
			</EnvironmentStatusProvider>
		</QueryClientProvider>,
	);
	return { onClose };
}

/** The sentence beside Deploy, carrying why it is (or is not) available as `data-block`. */
function reason() {
	return screen.getByTestId("deploy-reason");
}

/** Waits until the reason beside Deploy is `code`. */
async function untilBlock(code: string) {
	await vi.waitFor(() => expect(reason()).toHaveAttribute("data-block", code));
}

/** The Deploy button of step three. */
function deployButton() {
	return within(screen.getByRole("region", { name: "Step 3: Deploy" })).getByRole("button", {
		name: "Deploy",
	});
}

/** Step two's plan button, once the latest plan has been read. */
function planButton(name: "Run plan" | "Run plan again") {
	return within(screen.getByRole("region", { name: "Step 2: Plan" })).findByRole("button", { name });
}

/** A job change arrives on the change stream: the `jobs` topic's keys are invalidated. */
async function jobsHint() {
	await act(async () => {
		for (const queryKey of TOPIC_KEYS.jobs()) await client.invalidateQueries({ queryKey });
	});
}

beforeEach(() => {
	board.reset();
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	h.calls.length = 0;
	m.save.mockReset();
	m.plan.mockReset();
	m.apply.mockReset();
	m.parse.result = { success: true, data: {} };
	answer = NO_PLAN;
	planResult = {
		status: "SUCCESS",
		job_type: "PLAN",
		error_message: null,
		execution_metadata: {
			plan_result: {
				resource_changes: [
					resource("aws_vpc.main", ["create"]),
					resource("aws_subnet.a", ["create"]),
					resource("aws_db_instance.orders", ["update"]),
				],
			},
		},
	};
	h.handlers["canvas.reviewPlan"] = async () => answer;
	h.handlers["jobs.planResult"] = async () => planResult;
});

describe("ReviewView: the order of the view", () => {
	it("shows the design changes, then the plan, then Deploy", async () => {
		renderView();
		await untilBlock("no-plan");
		const steps = screen
			.getAllByRole("region")
			.map((region) => region.getAttribute("aria-label"))
			.filter((label) => label?.startsWith("Step"));
		expect(steps).toEqual(["Step 1: Design changes", "Step 2: Plan", "Step 3: Deploy"]);
	});

	it("Escape closes it", async () => {
		const { onClose } = renderView();
		await untilBlock("no-plan");
		await userEvent.setup().keyboard("{Escape}");
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe("ReviewView: Run plan", () => {
	it("saves the design first, then queues the plan, then commits the baseline and records the plan", async () => {
		board.document.getState().addNode("database");
		m.save.mockResolvedValue({ ok: true, data: { environmentId: ENVIRONMENT } });
		m.plan.mockResolvedValue({ ok: true, data: { jobId: PLAN } });
		renderView();
		await untilBlock("unsaved-edits");
		expect(deployButton()).toBeDisabled();

		const runPlan = await planButton("Run plan");
		// From here the server has a queued plan for this environment.
		answer = serverPlan({
			status: "QUEUED",
			summary: null,
			cost: null,
			current: false,
			staleReason: "plan-not-succeeded",
		});
		await userEvent.setup().click(runPlan);

		await vi.waitFor(() => expect(m.plan).toHaveBeenCalledTimes(1));
		expect(m.save).toHaveBeenCalledWith({ projectId: PROJECT, environmentId: ENVIRONMENT, design: {} });
		expect(m.plan).toHaveBeenCalledWith({ projectId: PROJECT, environmentId: ENVIRONMENT });
		expect(m.save.mock.invocationCallOrder[0]).toBeLessThan(m.plan.mock.invocationCallOrder[0]);

		await untilBlock("plan-waiting");
		const document = board.document.getState();
		expect(diffNodes(document.baseline, document.designNodes)).toEqual([]);
		expect(document.reviewedPlan?.planJobId).toBe(PLAN);
		expect(screen.getByRole("list", { name: "Changes saved in this review" })).toBeInTheDocument();
		// A plan that has not finished is not a plan to deploy, recorded or not.
		expect(deployButton()).toBeDisabled();
		expect(m.apply).not.toHaveBeenCalled();
	});

	it("Deploy becomes available when that plan finishes and the server calls it current", async () => {
		m.save.mockResolvedValue({ ok: true, data: { environmentId: ENVIRONMENT } });
		m.plan.mockResolvedValue({ ok: true, data: { jobId: PLAN } });
		m.apply.mockResolvedValue({ ok: true, data: { jobId: "job-deploy" } });
		renderView();
		await untilBlock("no-plan");

		const runPlan = await planButton("Run plan");
		answer = serverPlan({ status: "PROCESSING", current: false, staleReason: "plan-not-succeeded" });
		const user = userEvent.setup();
		await user.click(runPlan);
		await untilBlock("plan-running");

		answer = serverPlan();
		await jobsHint();
		await untilBlock("ready");
		expect(screen.getByTestId("plan-counts")).toHaveTextContent("2 to add · 1 to change · 0 to destroy");
		expect(
			await screen.findByRole("list", { name: "What the plan would change" }),
		).toHaveTextContent("aws_db_instance.orders");

		await user.click(deployButton());
		await vi.waitFor(() => expect(m.apply).toHaveBeenCalledTimes(1));
		expect(m.apply).toHaveBeenCalledWith({ planJobId: PLAN, runnerId: null });
		// The plan is spent: it is no longer the board's plan to deploy.
		await vi.waitFor(() => expect(board.document.getState().reviewedPlan).toBeNull());
	});

	it("a refused plan says why, in place, and records nothing", async () => {
		m.save.mockResolvedValue({ ok: true, data: { environmentId: ENVIRONMENT } });
		m.plan.mockResolvedValue({
			ok: false,
			error: { kind: "conflict", message: "Connect a cloud account for this project before planning." },
		});
		renderView();
		await untilBlock("no-plan");
		await userEvent.setup().click(await planButton("Run plan"));
		expect(
			await screen.findByText(/Connect a cloud account for this project before planning\./),
		).toBeInTheDocument();
		expect(board.document.getState().reviewedPlan).toBeNull();
	});
});

describe("ReviewView: Deploy is enabled only for a reviewed, current plan", () => {
	it("applies exactly the reviewed plan, once", async () => {
		board.document.getState().recordReviewedPlan(PLAN);
		answer = serverPlan();
		m.apply.mockResolvedValue({ ok: true, data: { jobId: "job-deploy" } });
		renderView();
		await untilBlock("ready");
		expect(deployButton()).toBeEnabled();

		await userEvent.setup().click(deployButton());
		await vi.waitFor(() => expect(m.apply).toHaveBeenCalledTimes(1));
		expect(m.apply).toHaveBeenCalledWith({ planJobId: PLAN, runnerId: null });
		expect(m.save).not.toHaveBeenCalled();
		expect(m.plan).not.toHaveBeenCalled();
	});

	it("a current plan that was not confirmed here stays disabled until Use this plan", async () => {
		answer = serverPlan();
		renderView();
		await untilBlock("not-reviewed");
		expect(deployButton()).toBeDisabled();

		await userEvent.setup().click(screen.getByRole("button", { name: "Use this plan" }));
		await untilBlock("ready");
		expect(deployButton()).toBeEnabled();
		expect(board.document.getState().reviewedPlan?.planJobId).toBe(PLAN);
	});

	it("a plan recorded here is not enough when the server's latest plan is another one", async () => {
		board.document.getState().recordReviewedPlan(PLAN);
		answer = serverPlan({ planJobId: "22222222-2222-4222-8222-222222222222" });
		renderView();
		await untilBlock("not-reviewed");
		expect(deployButton()).toBeDisabled();
	});

	it.each<[string, Partial<ReviewPlan>, string, RegExp]>([
		["no plan yet", NO_PLAN, "no-plan", /No plan yet/],
		[
			"the plan failed",
			{ status: "FAILED", current: false, staleReason: "plan-not-succeeded" },
			"plan-failed",
			/The plan failed/,
		],
		[
			"the design changed since the plan",
			{ current: false, staleReason: "design-changed" },
			"design-changed",
			/design changed since the plan/i,
		],
		[
			"something ran since",
			{ current: false, staleReason: "run-since-plan" },
			"run-since-plan",
			/Something ran on this environment since the plan/,
		],
	])("%s: disabled, with the reason and Run plan as the fix", async (_name, over, code, words) => {
		board.document.getState().recordReviewedPlan(PLAN);
		answer = serverPlan(over);
		renderView();
		await untilBlock(code);
		expect(reason()).toHaveTextContent(words);
		expect(deployButton()).toBeDisabled();
		expect(deployButton()).toHaveAccessibleDescription(words);
		const stepThree = screen.getByRole("region", { name: "Step 3: Deploy" });
		expect(within(stepThree).getByRole("button", { name: "Run plan" })).toBeEnabled();
	});

	it("shows a failed plan's first line and a link to its log", async () => {
		answer = serverPlan({ status: "FAILED", current: false, staleReason: "plan-not-succeeded" });
		planResult = {
			status: "FAILED",
			job_type: "PLAN",
			error_message: "Error: quota exceeded for vCPUs\n  on main.tf line 4",
			execution_metadata: null,
		};
		renderView();
		await untilBlock("plan-failed");
		expect(await screen.findByText("Error: quota exceeded for vCPUs")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "View the plan log" })).toHaveAttribute(
			"href",
			`/acme/~/jobs?job=${PLAN}`,
		);
	});

	it("unsaved edits disable it even with a recorded, current plan", async () => {
		board.document.getState().recordReviewedPlan(PLAN);
		answer = serverPlan();
		renderView();
		await untilBlock("ready");

		act(() => {
			board.document.getState().addNode("database");
		});
		await untilBlock("unsaved-edits");
		expect(reason()).toHaveTextContent(/design changed since the plan/i);
		expect(deployButton()).toBeDisabled();
	});

	it("the cloud is not available: neither Run plan nor Deploy, with the server's sentence", async () => {
		board.document.getState().recordReviewedPlan(PLAN);
		answer = serverPlan();
		renderView({
			deployRefusal: { reason: "cloud-not-offered", message: "Alibaba Cloud is not available here." },
		});
		await untilBlock("cloud-not-offered");
		expect(reason()).toHaveTextContent("Alibaba Cloud is not available here.");
		expect(deployButton()).toBeDisabled();
		const runPlan = await planButton("Run plan again");
		expect(runPlan).toBeDisabled();
		expect(runPlan).toHaveAccessibleDescription("Alibaba Cloud is not available here.");
	});

	it("never calls the deploy action while it is disabled", async () => {
		answer = serverPlan({ current: false, staleReason: "design-changed" });
		renderView();
		await untilBlock("design-changed");
		await userEvent.setup().click(deployButton());
		expect(m.apply).not.toHaveBeenCalled();
	});
});

describe("ReviewView: a deploy in flight", () => {
	it("queued and not started: shown as waiting, with why and where to look", async () => {
		renderView({ activeJob: { id: "job-deploy", type: "DEPLOY", status: "QUEUED" } });
		const waiting = await screen.findByTestId("deploy-in-flight");
		expect(waiting).toHaveTextContent("Waiting to start");
		expect(waiting).toHaveTextContent(/has not started/);
		expect(waiting).toHaveTextContent(/approval can take up to 60 minutes/);
		expect(within(waiting).getByRole("link", { name: "Open the job" })).toHaveAttribute(
			"href",
			"/acme/~/jobs?job=job-deploy",
		);
		expect(deployButton()).toBeDisabled();
	});

	it("running: says so and links to the log", async () => {
		renderView({ activeJob: { id: "job-deploy", type: "DEPLOY", status: "PROCESSING" } });
		const running = await screen.findByTestId("deploy-in-flight");
		expect(running).toHaveTextContent("The deploy is running");
		expect(within(running).getByRole("link", { name: "View log" })).toBeInTheDocument();
	});
});

describe("ReviewView: a plan that destroys something", () => {
	it("asks for the environment's name before it deploys", async () => {
		board.document.getState().recordReviewedPlan(PLAN);
		answer = serverPlan({ summary: { create: 0, update: 0, delete: 1, replace: 0 } });
		planResult = {
			status: "SUCCESS",
			job_type: "PLAN",
			error_message: null,
			execution_metadata: {
				plan_result: { resource_changes: [resource("aws_db_instance.orders", ["delete"])] },
			},
		};
		m.apply.mockResolvedValue({ ok: true, data: { jobId: "job-deploy" } });
		renderView();
		await untilBlock("ready");
		expect(reason()).toHaveTextContent(/destroys or replaces 1 resource/);
		await screen.findByRole("list", { name: "What the plan would change" });

		const user = userEvent.setup();
		await user.click(deployButton());
		const question = await screen.findByRole("alertdialog");
		expect(m.apply).not.toHaveBeenCalled();
		expect(question).toHaveTextContent("aws_db_instance.orders");
		const confirm = within(question).getByRole("button", { name: "Deploy" });
		expect(confirm).toBeDisabled();

		await user.type(within(question).getByRole("textbox"), "production");
		await vi.waitFor(() => expect(confirm).toBeEnabled());
		await user.click(confirm);
		await vi.waitFor(() => expect(m.apply).toHaveBeenCalledTimes(1));
		expect(m.apply).toHaveBeenCalledWith({ planJobId: PLAN, runnerId: null });
	});
});

describe("ReviewView: design changes", () => {
	it("lists each change, and one row's Discard reverts that change and no other", async () => {
		const document = board.document.getState();
		const { id: databaseId } = document.addNode("database");
		board.document.getState().commitBaseline();
		const nameOf = () => {
			const node = board.document.getState().designNodes.find((n) => n.id === databaseId);
			return node ? configName(node.data) : undefined;
		};
		const savedName = nameOf();
		expect(savedName).toBeTruthy();
		board.document.getState().updateNodeConfig(databaseId, { name: "orders-renamed" });
		board.document.getState().addNode("cache");
		renderView();
		await untilBlock("unsaved-edits");

		const changes = screen.getByRole("list", { name: "Pending design changes" });
		expect(changes).toHaveTextContent("orders-renamed");
		expect(within(changes).getByRole("button", { name: /^Discard new Cache/ })).toBeInTheDocument();

		await userEvent
			.setup()
			.click(within(changes).getByRole("button", { name: /^Discard the change to Name on Database/ }));

		const after = board.document.getState();
		expect(nameOf()).toBe(savedName);
		expect(diffNodes(after.baseline, after.designNodes).map((c) => `${c.op}:${c.kind}`)).toEqual([
			"new:cache",
		]);
	});

	it("says so when nothing is pending", async () => {
		renderView();
		await untilBlock("no-plan");
		expect(screen.getByText(/Nothing is pending/)).toBeInTheDocument();
	});
});

describe("ReviewView: issues", () => {
	it("tells an issue in words, blocks the plan, and Go to opens the card on the field", async () => {
		const { id: databaseId } = board.document.getState().addNode("database");
		m.parse.result = {
			success: false,
			error: { issues: [{ path: ["databases", 0, "port"], message: "Port is required" }] },
		};
		renderView();
		await untilBlock("issues");

		const issues = screen.getByRole("region", { name: "Issues to fix before planning" });
		expect(issues).toHaveTextContent("Port");
		expect(issues).toHaveTextContent("Port is required");
		// No validator path anywhere in the view.
		const view = screen.getByRole("region", { name: "Review and deploy" });
		expect(view.textContent).not.toContain("databases");
		expect(view.textContent).not.toMatch(/\.0\./);

		const runPlan = await planButton("Run plan");
		expect(runPlan).toBeDisabled();
		expect(runPlan).toHaveAccessibleDescription(/1 issue/);

		await userEvent.setup().click(within(issues).getByRole("button", { name: /^Go to Database/ }));
		expect(board.view.getState().subject).toEqual({ kind: "node", id: databaseId });
		expect(board.view.getState().focus).toEqual({ nodeId: databaseId, path: "port" });
		expect(m.save).not.toHaveBeenCalled();
	});
});

describe("the change stream reaches the review's plan read", () => {
	it("a jobs hint and an environments hint both invalidate canvas.reviewPlan", () => {
		expect(TOPIC_KEYS.jobs()).toContainEqual([["canvas", "reviewPlan"]]);
		expect(TOPIC_KEYS.environments()).toContainEqual([["canvas", "reviewPlan"]]);
	});
});
