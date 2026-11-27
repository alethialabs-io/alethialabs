// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A chart's safety scan and a module's safety scan are subjects of the one inspector. Pinned: the
// one action a scan has — run it again — is in the frame's action slot, where every subject's
// action is; before there is a verdict the body's own call to action is the only one; and inside a
// frame that is already on screen (the environment's Sources) a scan is a section, with its action
// beside its heading and no second close control.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChartScanBody } from "@/components/design-project/canvas/cards/chart-scan-card";
import { IacScanBody } from "@/components/design-project/canvas/cards/iac-scan-card";
import { InspectorEmbed } from "@/components/design-project/canvas/inspector-shell/inspector-frame";
import type { IacScanReport, VerifyReport } from "@/types/jsonb.types";

const CHART_REPORT: VerifyReport = {
	verdict: "pass",
	catalog_version: "1",
	provider: "aws",
	controls: [],
	summary: { pass: 3, warn: 0, fail: 0, not_evaluable: 0 },
};

const IAC_REPORT: IacScanReport = {
	ok: true,
	validated: true,
	findings: [],
	providers: [],
	modules: [],
};

const chartProps = {
	onClose: vi.fn(),
	chartId: "web",
	repoUrl: "https://github.com/acme/charts",
	chartPath: "charts/web",
	chartRef: "main",
};

const iacProps = {
	onClose: vi.fn(),
	repoUrl: "https://github.com/acme/infra-tofu",
	path: "infra/prod",
	scanRef: "main",
};

describe("a chart's safety scan, as a subject", () => {
	it("says which chart it is, in the frame's heading, with one close control", () => {
		render(
			<ChartScanBody
				{...chartProps}
				scanStatus="done"
				scanning={false}
				report={CHART_REPORT}
				onRescan={vi.fn()}
			/>,
		);
		expect(screen.getByRole("heading", { level: 2, name: "web" })).toBeInTheDocument();
		expect(screen.getByText("Chart safety scan")).toBeInTheDocument();
		expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
	});

	it("offers Rescan once, in the frame's action slot, when there is a verdict to refresh", async () => {
		const onRescan = vi.fn();
		render(
			<ChartScanBody
				{...chartProps}
				scanStatus="done"
				scanning={false}
				report={CHART_REPORT}
				onRescan={onRescan}
			/>,
		);
		const rescan = screen.getAllByRole("button", { name: "Rescan" });
		expect(rescan).toHaveLength(1);
		await userEvent.setup().click(rescan[0]);
		expect(onRescan).toHaveBeenCalledTimes(1);
	});

	it("before the first scan, the body's call to action is the only one", () => {
		render(
			<ChartScanBody
				{...chartProps}
				scanStatus="unscanned"
				scanning={false}
				report={null}
				onRescan={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("button", { name: "Rescan" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /scan chart/i })).toBeInTheDocument();
	});

	it("offers nothing to press while a scan is running", () => {
		render(
			<ChartScanBody
				{...chartProps}
				scanStatus="scanning"
				scanning
				report={CHART_REPORT}
				onRescan={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("button", { name: "Rescan" })).not.toBeInTheDocument();
		// The wait is the [·] mark loader, announced as what is running, with the chart's own
		// coordinates as its status line rather than a spinner.
		const loader = screen.getByRole("status");
		expect(loader).toHaveAttribute("data-slot", "mark-loader");
		expect(loader).toHaveTextContent(/running security checks/i);
		expect(loader.querySelector(".ah-loader__status")?.textContent).toMatch(/^Scanning · web · \//);
		expect(document.querySelector(".animate-spin")).toBeNull();
	});
});

describe("a module's safety scan, inside the environment's Sources", () => {
	it("is a section: a heading, its action beside it, and no close control of its own", async () => {
		const onRescan = vi.fn();
		render(
			<InspectorEmbed>
				<IacScanBody
					{...iacProps}
					scanStatus="done"
					scanning={false}
					report={IAC_REPORT}
					onRescan={onRescan}
				/>
			</InspectorEmbed>,
		);
		expect(
			screen.getByRole("heading", { level: 3, name: "github.com/acme/infra-tofu" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
		await userEvent.setup().click(screen.getByRole("button", { name: "Rescan" }));
		expect(onRescan).toHaveBeenCalledTimes(1);
	});

	it("on the rail by itself it is drawn in the frame, like every other subject", () => {
		render(
			<IacScanBody
				{...iacProps}
				scanStatus="done"
				scanning={false}
				report={IAC_REPORT}
				onRescan={vi.fn()}
			/>,
		);
		expect(
			screen.getByRole("heading", { level: 2, name: "github.com/acme/infra-tofu" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
	});
});
