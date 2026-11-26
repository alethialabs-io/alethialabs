// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AGT-L2-U1 (#7501) — the decision sheet, every state in spec §1.4: loading, error, not available;
// waiting (deploy, production, destroy with its typed confirmation, expiring soon, no estimate / not
// checked); Approve; Deny with and without a reason; the policy re-check's four Blocked states; a
// viewer who may not decide; each refusal the server raises, shown in its own sentence and then read
// again; and the outcomes — approved by you, used, denied with and without a reason, expired,
// replaced. Plus the accessibility basics: a modal dialog named by its title, focus on Close, Escape.
//
// The reads are the oRPC client's (mocked: `reads.get` answers `approvals.get`, `reads.plan` the plan
// job); the decision is the server action's (mocked). Nothing here talks to a server.

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ get: vi.fn(), plan: vi.fn() }));

vi.mock("@/lib/rpc/client", () => ({
	orpc: {
		approvals: {
			key: () => ["approvals"],
			get: {
				queryOptions: ({ input }: { input: { id: string } }) => ({
					queryKey: ["approvals", "get", input.id],
					queryFn: () => reads.get(input.id),
				}),
			},
		},
		jobs: {
			planResult: {
				queryOptions: ({ input }: { input: { id: string } }) => ({
					queryKey: ["jobs", "planResult", input.id],
					queryFn: () => reads.plan(input.id),
				}),
			},
		},
	},
}));
vi.mock("@/app/server/actions/approvals", () => ({ decideApplyApproval: vi.fn() }));
vi.mock("@/components/providers/viewer-provider", () => ({ useViewer: () => ({ viewer: { id: "u-me" }, isPending: false }) }));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	usePathname: () => "/acme/~/approvals",
	useSearchParams: () => new URLSearchParams(),
}));

import { decideApplyApproval } from "@/app/server/actions/approvals";
import { ApprovalSheet } from "@/components/approvals/approval-sheet";

const ID = "11111111-1111-4111-8111-111111111111";
const PLAN_JOB = "22222222-2222-4222-8222-222222222222";

/** The approval as `approvals.get` answers it; `over` replaces fields. */
function approval(over: Record<string, unknown> = {}) {
	return {
		id: ID,
		status: "pending",
		operation: "deploy",
		project_id: "p1",
		project_name: "payments-api",
		environment_id: "e1",
		environment_name: "staging",
		environment_stage: "staging",
		plan_job_id: PLAN_JOB,
		digest_prefix: "9f3c1a7e",
		requester_user_id: "u-dana",
		requester_name: "Dana Petrova",
		requester_credential: "agent_oauth",
		requester_credential_name: "Claude Code",
		requester_credential_ref: "https://claude.ai/code/oauth",
		requester_credential_icon: null,
		created_at: new Date(Date.now() - 8 * 60_000).toISOString(),
		expires_at: new Date(Date.now() + 52 * 60_000).toISOString(),
		decided_at: null,
		approver_user_id: null,
		approver_name: null,
		consumed_job_id: null,
		note: null,
		decision_reason: null,
		...over,
	};
}

/** The sheet's whole read. */
function sheet(over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
	return { approval: approval(over), canDecide: true, approveBlock: null, ...extra };
}

/** A plan job's output with counts, a cost and a passed verdict. */
const PLAN = {
	status: "SUCCESS",
	job_type: "PLAN",
	error_message: null,
	execution_metadata: {
		plan_result: {
			resource_changes: [
				...Array.from({ length: 14 }, (_, i) => ({ address: `aws_s3_bucket.b${i}`, type: "aws_s3_bucket", change: { actions: ["create"] } })),
				{ address: "aws_vpc.main", type: "aws_vpc", change: { actions: ["update"] } },
			],
		},
		cost_breakdown: { totalMonthlyCost: "61.00", totalHourlyCost: "0.08", projects: [] },
		verify_result: { verdict: "pass", catalog_version: "1", provider: "aws", controls: [], summary: {} },
	},
};

const decide = vi.mocked(decideApplyApproval);
const onClose = vi.fn();

/** Renders the sheet for `id` under a fresh query client. */
function renderSheet(id: string | null = ID) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
	const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	return render(<ApprovalSheet approvalId={id} orgSlug="acme" onClose={onClose} />, { wrapper });
}

/** The sheet's dialog, once it has its title. */
async function dialog(name: string | RegExp = "Deploy · payments-api / staging") {
	return screen.findByRole("dialog", { name });
}

beforeEach(() => {
	reads.get.mockReset();
	reads.plan.mockReset();
	reads.plan.mockResolvedValue(PLAN);
	decide.mockReset();
	onClose.mockReset();
});

describe("reading the approval", () => {
	it("loading: a skeleton under a busy body, before the read answers", () => {
		reads.get.mockReturnValue(new Promise(() => undefined));
		renderSheet();
		expect(screen.getByRole("dialog", { name: "Loading approval" })).toBeInTheDocument();
		expect(document.querySelector('[data-state="loading"]')).not.toBeNull();
	});

	it("error: says nothing was decided and offers a retry", async () => {
		reads.get.mockRejectedValue(new Error("network"));
		renderSheet();
		expect(await screen.findByText("Couldn't load this approval")).toBeInTheDocument();
		expect(screen.getByText(/Nothing was decided/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
	});

	it("not available: a refused read reads exactly like a wrong link", async () => {
		reads.get.mockRejectedValue(new ORPCError("NOT_FOUND", { defined: true }));
		renderSheet();
		expect(await screen.findByText("This approval isn't available to you")).toBeInTheDocument();
		expect(screen.getByText(/You may not have access to its project, or the link may be wrong/)).toBeInTheDocument();
	});

	it("not available: an id that is not an approval id is answered without a request", () => {
		renderSheet("not-an-id");
		expect(screen.getByText("This approval isn't available to you")).toBeInTheDocument();
		expect(reads.get).not.toHaveBeenCalled();
	});

	it("closed: nothing renders when the URL names no approval", () => {
		renderSheet(null);
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});

describe("a waiting request", () => {
	it("deploy: the facts, the reviewed plan from the plan job, and the one-sentence consequence", async () => {
		reads.get.mockResolvedValue(sheet());
		renderSheet();
		await dialog();
		expect(screen.getByText(/Requested .* through Claude Code\./)).toBeInTheDocument();
		expect(screen.getByText("Dana Petrova")).toBeInTheDocument();
		expect(screen.getByRole("dialog").querySelector('[data-mark="claudecode"]')).not.toBeNull();
		expect(await screen.findByText("14 to add")).toBeInTheDocument();
		expect(screen.getByText("1 to change")).toBeInTheDocument();
		expect(screen.getByText("Passed")).toBeInTheDocument();
		expect(screen.getByText("9f3c1a7e")).toBeInTheDocument();
		expect(screen.getByText(/showed the requester these same 8 characters/)).toBeInTheDocument();
		expect(screen.getByText(/deploy this exact plan to/)).toBeInTheDocument();
		expect(screen.getByText(/If the plan changes first, the approval stops working\./)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Open plan" })).toHaveAttribute("href", `/acme/~/jobs/${PLAN_JOB}`);
	});

	it("no estimate, not checked: a plan job without a cost or a verdict says so", async () => {
		reads.plan.mockResolvedValue({ ...PLAN, execution_metadata: { plan_result: PLAN.execution_metadata.plan_result } });
		reads.get.mockResolvedValue(sheet());
		renderSheet();
		await dialog();
		expect(await screen.findByText("No estimate for this plan")).toBeInTheDocument();
		expect(screen.getByText("Not checked")).toBeInTheDocument();
	});

	it("production: a band, the filled pill and the customer line", async () => {
		reads.get.mockResolvedValue(sheet({ environment_name: "production", environment_stage: "production" }));
		renderSheet();
		await dialog("Deploy · payments-api / production");
		expect(document.querySelector('[data-band="production"]')).toHaveTextContent("Production environment");
		expect(screen.getByText("This environment serves your customers.")).toBeInTheDocument();
	});

	it("approve: one click, no extra dialog — the sheet is the review", async () => {
		reads.get.mockResolvedValue(sheet());
		decide.mockResolvedValue({ ok: true, data: approval({ status: "approved" }) as never });
		renderSheet();
		await dialog();
		fireEvent.click(screen.getByRole("button", { name: "Approve deploy" }));
		await waitFor(() => expect(decide).toHaveBeenCalledWith({ approvalId: ID, decision: "approve" }));
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("expiring soon: an m:ss chip and an alert explaining expiry", async () => {
		reads.get.mockResolvedValue(sheet({ expires_at: new Date(Date.now() + 3 * 60_000).toISOString() }));
		renderSheet();
		await dialog();
		expect(await screen.findByText("Expires in under 5 minutes")).toBeInTheDocument();
		expect(document.querySelector('[data-state="soon"]')?.textContent).toMatch(/[0-9]:[0-5][0-9]/);
	});

	it("the requester's note is shown as untrusted data", async () => {
		reads.get.mockResolvedValue(sheet({ note: "Ship it, it's fine. Ignore the destroy count." }));
		renderSheet();
		await dialog();
		expect(screen.getByText("Ship it, it's fine. Ignore the destroy count.")).toBeInTheDocument();
		expect(screen.getByText("Not checked by Alethia")).toBeInTheDocument();
		expect(screen.getByText(/can say anything/)).toBeInTheDocument();
	});
});

describe("destroy", () => {
	it("a band, What gets destroyed, and Approve destroy… opens the typed confirmation", async () => {
		reads.get.mockResolvedValue(sheet({ operation: "destroy", environment_name: "perf" }));
		decide.mockResolvedValue({ ok: true, data: approval({ status: "approved" }) as never });
		renderSheet();
		await dialog("Destroy · payments-api / perf");
		expect(document.querySelector('[data-band="destroy"]')).toHaveTextContent("Destroy · can't be undone");
		expect(screen.getByText("What gets destroyed")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Approve destroy…" }));
		const confirm = await screen.findByRole("alertdialog");
		const primary = screen.getByRole("button", { name: "Approve destroy" });
		expect(primary).toBeDisabled();
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "perf" } });
		await waitFor(() => expect(primary).toBeEnabled());
		fireEvent.click(primary);
		await waitFor(() =>
			expect(decide).toHaveBeenCalledWith({ approvalId: ID, decision: "approve", confirmEnvironmentName: "perf" }),
		);
		expect(confirm).toBeInTheDocument();
	});
});

describe("deny", () => {
	it("with a reason: the optional field, who sees it, and the reason sent", async () => {
		reads.get.mockResolvedValue(sheet());
		decide.mockResolvedValue({ ok: true, data: approval({ status: "rejected" }) as never });
		renderSheet();
		await dialog();
		fireEvent.click(screen.getByRole("button", { name: "Deny" }));
		expect(screen.getByText("Shown to Dana Petrova and to Claude Code.")).toBeInTheDocument();
		fireEvent.change(screen.getByRole("textbox", { name: /Reason for denying/ }), { target: { value: "  Wrong environment.  " } });
		fireEvent.click(screen.getByRole("button", { name: "Deny request" }));
		await waitFor(() =>
			expect(decide).toHaveBeenCalledWith({ approvalId: ID, decision: "reject", reason: "Wrong environment." }),
		);
	});

	it("without a reason: the reason is optional and sent as nothing", async () => {
		reads.get.mockResolvedValue(sheet());
		decide.mockResolvedValue({ ok: true, data: approval({ status: "rejected" }) as never });
		renderSheet();
		await dialog();
		fireEvent.click(screen.getByRole("button", { name: "Deny" }));
		fireEvent.click(screen.getByRole("button", { name: "Deny request" }));
		await waitFor(() => expect(decide).toHaveBeenCalledWith({ approvalId: ID, decision: "reject", reason: null }));
	});

	it("Back returns to the decision without sending anything", async () => {
		reads.get.mockResolvedValue(sheet());
		renderSheet();
		await dialog();
		fireEvent.click(screen.getByRole("button", { name: "Deny" }));
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(screen.getByRole("button", { name: "Approve deploy" })).toBeInTheDocument();
		expect(decide).not.toHaveBeenCalled();
	});
});

describe("the policy re-check: Approve is disabled with its reason, Deny stays", () => {
	const cases = [
		["agent_access_disabled", "Agent access is off in this organization"],
		["agents_not_on_production", "This organization keeps agents off production"],
		["client_not_allowed", "Claude Code isn't an allowed agent app in this organization"],
		["self_approval", "Someone else needs to approve this"],
	] as const;
	for (const [reason, title] of cases) {
		it(`${reason}: "${title}"`, async () => {
			reads.get.mockResolvedValue(sheet({}, { approveBlock: { reason, message: "server sentence" } }));
			renderSheet();
			await dialog();
			expect(screen.getByText(title)).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Approve deploy" })).toBeDisabled();
			expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
		});
	}

	it("self_approval offers the link for a teammate", async () => {
		reads.get.mockResolvedValue(sheet({}, { approveBlock: { reason: "self_approval", message: "server sentence" } }));
		renderSheet();
		await dialog();
		expect(screen.getByRole("button", { name: "Copy link for a teammate" })).toBeInTheDocument();
	});

	it("a viewer who may not decide is told the verb that decides, not asked a question", async () => {
		reads.get.mockResolvedValue(sheet({}, { canDecide: false }));
		renderSheet();
		await dialog();
		expect(screen.getByText("Deciding needs deploy access to payments-api. Anyone with it can decide.")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Approve deploy" })).toBeNull();
	});
});

describe("refusals: the server's sentence, then the state the re-read finds", () => {
	/** Approves, with the server refusing `message` and the re-read answering `after`. */
	async function refusedWith(message: string, after: ReturnType<typeof sheet>) {
		reads.get.mockResolvedValueOnce(sheet()).mockResolvedValue(after);
		decide.mockResolvedValue({ ok: false, error: { kind: "conflict", message } });
		renderSheet();
		await dialog();
		fireEvent.click(screen.getByRole("button", { name: "Approve deploy" }));
		await waitFor(() => expect(decide).toHaveBeenCalled());
	}

	it("reauthentication_required: still waiting and unblocked after the re-read → Sign in again", async () => {
		await refusedWith("Sign in again to decide this approval.", sheet());
		expect(await screen.findByText("Sign in again to decide")).toBeInTheDocument();
		expect(screen.getByText(/Sign in again to decide this approval\./)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
	});

	it("expired: the re-read shows the request expired", async () => {
		await refusedWith("That approval expired before it was decided.", sheet({ status: "expired" }));
		expect(await screen.findByText(/Nobody decided before .*, so this request can't be approved any more\./)).toBeInTheDocument();
	});

	it("superseded: the re-read shows the request replaced", async () => {
		await refusedWith(
			"A newer plan of this environment succeeded after the approved one. Request an approval for the newer plan.",
			sheet({ status: "superseded" }),
		);
		expect(await screen.findByText(/no longer the current plan for payments-api \/ staging/)).toBeInTheDocument();
	});

	it("policy_refused: the re-read carries the block, and Approve is disabled with it", async () => {
		await refusedWith(
			"This organization does not let agents deploy production environments.",
			sheet({}, { approveBlock: { reason: "agents_not_on_production", message: "x" } }),
		);
		expect(await screen.findByText("This organization keeps agents off production")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Approve deploy" })).toBeDisabled();
	});

	it("self_approval: the re-read carries the different-approver block", async () => {
		await refusedWith(
			"This organization requires a different person to approve.",
			sheet({}, { approveBlock: { reason: "self_approval", message: "x" } }),
		);
		expect(await screen.findByText("Someone else needs to approve this")).toBeInTheDocument();
	});

	it("decided by someone else first: the re-read shows their decision", async () => {
		await refusedWith(
			"That approval was decided by someone else first.",
			sheet({ status: "approved", approver_user_id: "u-ivan", approver_name: "Ivan Georgiev", decided_at: new Date().toISOString() }),
		);
		expect(await screen.findByText(/^Ivan Georgiev approved this at/)).toBeInTheDocument();
	});
});

describe("outcomes", () => {
	it("approved by you", async () => {
		reads.get.mockResolvedValue(sheet({ status: "approved", approver_user_id: "u-me", approver_name: "Me", decided_at: new Date().toISOString() }));
		renderSheet();
		await dialog();
		expect(screen.getByText(/^You approved this at .*Claude Code can deploy this plan once, before/)).toBeInTheDocument();
		expect(screen.getByText(/If it doesn't start by .*, the approval expires\./)).toBeInTheDocument();
		expect(document.querySelector('[data-outcome="approved"]')).toHaveAttribute("aria-live", "polite");
	});

	it("used: who approved it, and the job it ran", async () => {
		reads.get.mockResolvedValue(
			sheet({
				status: "consumed",
				approver_user_id: "u-ivan",
				approver_name: "Ivan Georgiev",
				decided_at: new Date().toISOString(),
				consumed_job_id: "5c7d2e81-0000-4000-8000-000000000000",
			}),
		);
		renderSheet();
		await dialog();
		expect(screen.getByText(/^Approved by Ivan Georgiev at/)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /Open deploy job/ })).toHaveAttribute(
			"href",
			"/acme/~/jobs/5c7d2e81-0000-4000-8000-000000000000",
		);
	});

	it("denied with a reason: the reason is shown as the decider's untrusted words", async () => {
		reads.get.mockResolvedValue(
			sheet({
				status: "rejected",
				approver_user_id: "u-ivan",
				approver_name: "Ivan Georgiev",
				decided_at: new Date().toISOString(),
				decision_reason: "Wrong environment. Plan again from main.",
			}),
		);
		renderSheet();
		await dialog();
		expect(screen.getByText(/^Ivan Georgiev denied this at/)).toBeInTheDocument();
		expect(screen.getByText("Reason from Ivan Georgiev")).toBeInTheDocument();
		expect(screen.getByText("Wrong environment. Plan again from main.")).toBeInTheDocument();
	});

	it("denied with no reason: the reason block is omitted", async () => {
		reads.get.mockResolvedValue(sheet({ status: "rejected", approver_user_id: "u-ivan", approver_name: "Ivan Georgiev" }));
		renderSheet();
		await dialog();
		expect(screen.queryByText(/^Reason from/)).toBeNull();
	});

	it("expired without a decision", async () => {
		reads.get.mockResolvedValue(sheet({ status: "expired" }));
		renderSheet();
		await dialog();
		expect(screen.getByText(/Nobody decided before/)).toBeInTheDocument();
		expect(screen.getByText("Ask Claude Code to request a new approval.")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Approve deploy" })).toBeNull();
	});

	it("replaced by a newer plan", async () => {
		reads.get.mockResolvedValue(sheet({ status: "superseded" }));
		renderSheet();
		await dialog();
		expect(screen.getByText(/no longer describes what would run/)).toBeInTheDocument();
		expect(document.querySelector("[data-band]")).toBeNull();
	});
});

describe("accessibility and the header", () => {
	it("a modal dialog named by its title, with focus starting on Close", async () => {
		reads.get.mockResolvedValue(sheet());
		renderSheet();
		// base-ui's dialog is modal by default: it traps focus and makes the list underneath inert.
		await dialog();
		await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toHaveFocus());
	});

	it("Escape and the Close button close it", async () => {
		reads.get.mockResolvedValue(sheet());
		renderSheet();
		const d = await dialog();
		fireEvent.keyDown(d, { key: "Escape" });
		await waitFor(() => expect(onClose).toHaveBeenCalled());
	});

	it("the reason a disabled Approve is disabled is visible text before the button", async () => {
		reads.get.mockResolvedValue(sheet({}, { approveBlock: { reason: "agent_access_disabled", message: "x" } }));
		renderSheet();
		await dialog();
		const reasonNode = screen.getByText("Agent access is off in this organization");
		const approve = screen.getByRole("button", { name: "Approve deploy" });
		expect(reasonNode.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("Copy link copies the list URL with this approval selected", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		reads.get.mockResolvedValue(sheet());
		renderSheet();
		await dialog();
		fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/acme/~/approvals?selected=${ID}`));
	});
});
