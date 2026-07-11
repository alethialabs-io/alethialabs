// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component tests for the read-only external-IaC node: it renders the module coords (repo · ref ·
// path), the pinned + deployed commit short-shas, the deployed indicator, and a scan-status chip
// that opens the findings sheet. The server actions (detach/scan) are mocked.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IacNode } from "@/components/design-project/byo/iac-node";
import {
	IacSourceCanvasProvider,
	type IacSourceCanvasContextValue,
} from "@/components/design-project/byo/iac-source-canvas-context";
import type { IacSourceState } from "@/app/server/actions/byo-iac";

vi.mock("@/app/server/actions/byo-iac", () => ({
	detachIacSource: vi.fn().mockResolvedValue({ ok: true }),
	scanIacSource: vi.fn().mockResolvedValue({ ok: true, jobId: "job-1" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

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
		refresh: vi.fn(),
	};
	return render(
		<IacSourceCanvasProvider value={ctx}>
			<IacNode source={source} />
		</IacSourceCanvasProvider>,
	);
}

describe("IacNode", () => {
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

	it("opens the scan sheet when the chip is clicked", async () => {
		const user = userEvent.setup();
		renderNode(makeSource());
		await user.click(screen.getByTitle("IaC safety scan"));
		expect(await screen.findByText(/no blocking issues found/i)).toBeInTheDocument();
	});
});
