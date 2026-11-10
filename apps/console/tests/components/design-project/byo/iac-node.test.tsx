// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component tests for the read-only external-IaC node: it renders the module coords (repo · ref ·
// path), the pinned + deployed commit short-shas, the deployed indicator, and a scan-status chip
// that opens the findings card on the workspace rail. The detach action is mocked; it is on the
// mutation contract (#6119), so the node renders inside a query client.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IacNode } from "@/components/design-project/byo/iac-node";
import {
	IacSourceCanvasProvider,
	type IacSourceCanvasContextValue,
} from "@/components/design-project/byo/iac-source-canvas-context";
import { detachIacSourceAction, type IacSourceState } from "@/app/server/actions/byo-iac";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

vi.mock("@/app/server/actions/byo-iac", () => ({
	detachIacSourceAction: vi.fn().mockResolvedValue({ ok: true, data: { projectId: "proj-1" } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});
const { toast } = vi.hoisted(() => ({
	toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));
vi.mock("sonner", () => ({ toast }));
const detachIacSource = vi.mocked(detachIacSourceAction);

/** A fully-populated attached source (scanned + deployed). */
function makeSource(overrides: Partial<IacSourceState> = {}): IacSourceState {
	return {
		id: "src-1",
		environmentId: "env-1",
		name: "infra-tofu",
		repoUrl: "https://github.com/acme/infra-tofu",
		ref: "main",
		path: "infra/prod",
		commitSha: "abcdef1234567890",
		deployedCommitSha: "0123456789abcdef",
		gitCredentialId: null,
		varValues: {},
		enabled: true,
		scanStatus: "done",
		scanReport: { ok: true, validated: true, findings: [], providers: [], modules: [] },
		scannedAt: null,
		status: "READY",
		statusMessage: null,
		...overrides,
	};
}

/** Renders the node inside a canvas context so detach/rescan wiring is live. */
function renderNode(source: IacSourceState) {
	const ctx: IacSourceCanvasContextValue = {
		projectId: "proj-1",
		environmentId: "env-1",
		source,
	};
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<IacSourceCanvasProvider value={ctx}>
				<IacNode source={source} />
			</IacSourceCanvasProvider>
		</QueryClientProvider>,
	);
}

describe("IacNode", () => {
	beforeEach(() => {
		detachIacSource.mockClear();
		detachIacSource.mockResolvedValue({ ok: true, data: { projectId: "proj-1" } });
		toast.success.mockClear();
		toast.error.mockClear();
	});

	it("renders repo, ref, path and the pinned + deployed short-shas", () => {
		renderNode(makeSource());
		expect(screen.getByText("github.com/acme/infra-tofu")).toBeInTheDocument();
		expect(screen.getByText("main")).toBeInTheDocument();
		expect(screen.getByText("/infra/prod")).toBeInTheDocument();
		// Pinned + deployed shown as 7-char shas.
		expect(screen.getByText("abcdef1")).toBeInTheDocument();
		expect(screen.getByText("0123456")).toBeInTheDocument();
		expect(screen.getByText("DEPLOYED")).toBeInTheDocument();
	});

	it("shows NOT DEPLOYED and no deployed sha before a deploy", () => {
		renderNode(makeSource({ deployedCommitSha: null }));
		expect(screen.getByText("NOT DEPLOYED")).toBeInTheDocument();
		expect(screen.queryByText(/^deployed/)).not.toBeInTheDocument();
	});

	it("reflects the scan status in the chip", () => {
		renderNode(makeSource({ scanStatus: "failed", scanReport: null }));
		expect(screen.getByText("Scan failed")).toBeInTheDocument();
	});

	it("renders a finding count when the scan found issues", () => {
		renderNode(
			makeSource({
				scanReport: {
					ok: false,
					validated: false,
					findings: [{ severity: "high", rule: "R1", file: "main.tf", detail: "d" }],
					providers: [],
					modules: [],
				},
			}),
		);
		expect(screen.getByText("1 finding")).toBeInTheDocument();
	});

	it("opens the scan card on the workspace rail when the chip is clicked", async () => {
		const user = userEvent.setup();
		useCanvasStore.getState().closeCard();
		renderNode(makeSource());
		await user.click(screen.getByTitle("IaC safety scan"));
		expect(useCanvasStore.getState().card).toEqual({ kind: "iac-scan" });
	});

	// ── the confirmation (#4281), and the state in which it is not offered at all (#4600 review).
	//
	// These two assert what `destructive-actions.yaml`'s `byo.iac.detach: confirmed` CLAIMS. The
	// live spec cannot observe it — it needs an attached BYO source it has no fixture for — and the
	// static census only proves `detachIacSource` OCCURS in this file, which stays true however the
	// click is wired. Without them, restoring `onClick={() => void detach()}` in a later refactor
	// leaves the ledger saying `confirmed` with nothing red anywhere.

	it("does NOT detach on a bare click — the X opens the confirmation", async () => {
		const user = userEvent.setup();
		renderNode(makeSource({ deployedCommitSha: null }));
		await user.click(screen.getByTitle("Detach IaC source"));
		expect(detachIacSource).not.toHaveBeenCalled();
		expect(screen.getByText("Detach this IaC source?")).toBeInTheDocument();
	});

	it("detaches only from the dialog's confirm", async () => {
		const user = userEvent.setup();
		renderNode(makeSource({ deployedCommitSha: null }));
		await user.click(screen.getByTitle("Detach IaC source"));
		await user.click(screen.getByRole("button", { name: "Detach source" }));
		await waitFor(() =>
			expect(detachIacSource).toHaveBeenCalledWith({
				projectId: "proj-1",
				environmentId: "env-1",
			}),
		);
		// The mutation's confirmation, and the trigger held while the card waits to leave the board.
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith(
				"IaC source detached — this environment falls back to the built-in template.",
			),
		);
		expect(screen.getByTitle("Detach IaC source")).toBeDisabled();
	});

	it("toasts the refusal's sentence when the server refuses the detach", async () => {
		const refusal =
			"This environment has infrastructure deployed from its IaC source — destroy it before detaching.";
		detachIacSource.mockResolvedValue({ ok: false, error: { kind: "conflict", message: refusal } });
		const user = userEvent.setup();
		renderNode(makeSource({ deployedCommitSha: null }));
		await user.click(screen.getByTitle("Detach IaC source"));
		await user.click(screen.getByRole("button", { name: "Detach source" }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith(refusal));
		expect(toast.success).not.toHaveBeenCalled();
		// Not held: the source is still attached, so the person may try again.
		expect(screen.getByTitle("Detach IaC source")).toBeEnabled();
	});

	// `detachIacSource` throws — and deletes nothing — once a deploy has applied the module. Offering
	// the confirmation there would state an outcome the server refuses and end in an error toast, so
	// the trigger is disabled and the card says why. The accessible NAME stays "Detach IaC source"
	// in both states: it is what the registry locates the control by.
	it("disables the X, with the reason, while a commit is deployed from the source", () => {
		renderNode(makeSource({ deployedCommitSha: "0123456789abcdef" }));
		expect(screen.getByTitle("Detach IaC source")).toBeDisabled();
		expect(
			screen.getByText(/destroy this environment before detaching/i),
		).toBeInTheDocument();
	});
});
