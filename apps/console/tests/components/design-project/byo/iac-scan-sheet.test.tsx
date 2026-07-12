// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component tests for the IaC scan sheet: the ok verdict + per-severity summary, findings rendered
// worst-first with their file:line + rule, the discovered providers/modules inventory, and the
// scanning / unscanned empty states.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IacScanSheet } from "@/components/design-project/byo/iac-scan-sheet";
import type { IacScanReport } from "@/types/jsonb.types";

const baseProps = {
	open: true,
	onOpenChange: vi.fn(),
	repoUrl: "https://github.com/acme/infra-tofu",
	path: "infra/prod",
	scanRef: "main",
	onRescan: vi.fn(),
};

const REPORT: IacScanReport = {
	ok: false,
	validated: true,
	findings: [
		{ severity: "low", rule: "LOW1", file: "net.tf", line: 3, detail: "minor" },
		{ severity: "high", rule: "HIGH1", file: "main.tf", line: 12, detail: "risky" },
		{ severity: "medium", rule: "MED1", file: "db.tf", detail: "watch out" },
	],
	providers: ["registry.opentofu.org/hashicorp/aws"],
	modules: ["git::https://github.com/acme/mod.git"],
};

describe("IacScanSheet", () => {
	it("renders the ok verdict when the scan passed", () => {
		render(
			<IacScanSheet
				{...baseProps}
				scanStatus="done"
				scanning={false}
				report={{ ok: true, validated: true, findings: [], providers: [], modules: [] }}
			/>,
		);
		expect(screen.getByText(/no blocking issues found/i)).toBeInTheDocument();
		expect(screen.getByText(/passed the iacsafety checks/i)).toBeInTheDocument();
	});

	it("renders findings grouped by severity with file:line + rule, worst-first", () => {
		render(<IacScanSheet {...baseProps} scanStatus="done" scanning={false} report={REPORT} />);
		expect(screen.getByText(/issues found — resolve before deploying/i)).toBeInTheDocument();
		// Rules present.
		expect(screen.getByText("HIGH1")).toBeInTheDocument();
		expect(screen.getByText("MED1")).toBeInTheDocument();
		expect(screen.getByText("LOW1")).toBeInTheDocument();
		// file:line coord.
		expect(screen.getByText("main.tf:12")).toBeInTheDocument();
		// A finding without a line drops the ":n" suffix.
		expect(screen.getByText("db.tf")).toBeInTheDocument();

		// Worst-first: the high-severity finding renders before the low-severity one in the DOM.
		const high = screen.getByText("HIGH1");
		const low = screen.getByText("LOW1");
		expect(high.compareDocumentPosition(low) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("lists discovered providers and modules", () => {
		render(<IacScanSheet {...baseProps} scanStatus="done" scanning={false} report={REPORT} />);
		expect(screen.getByText("Providers")).toBeInTheDocument();
		expect(screen.getByText("registry.opentofu.org/hashicorp/aws")).toBeInTheDocument();
		expect(screen.getByText("Modules")).toBeInTheDocument();
		expect(screen.getByText("git::https://github.com/acme/mod.git")).toBeInTheDocument();
	});

	it("shows a spinner while scanning", () => {
		render(<IacScanSheet {...baseProps} scanStatus="scanning" scanning report={null} />);
		expect(screen.getByText(/scanning the module/i)).toBeInTheDocument();
	});

	it("shows the unscanned empty state with a scan action", () => {
		render(<IacScanSheet {...baseProps} scanStatus="unscanned" scanning={false} report={null} />);
		expect(screen.getByText(/hasn't been scanned yet/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /scan module/i })).toBeInTheDocument();
	});
});
