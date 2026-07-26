// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component tests for the BYO Helm chart attach dialog, focused on the OCI branch added for #1247:
// an OCI chart is one URL + a chart version (no chart path, no git ref), and the wizard must send
// exactly that shape to attachByoChart — `chartPath` omitted so the server stores null, and the
// version defaulting to `*` rather than the git-flavoured HEAD. The git branch must keep working
// unchanged. The heavy RepositorySelector is stubbed; its auth/fetch internals aren't under test.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ByoChartDialog } from "@/components/design-project/byo/byo-chart-dialog";

const { attachByoChart } = vi.hoisted(() => ({ attachByoChart: vi.fn() }));
vi.mock("@/app/server/actions/byo-charts", () => ({
	attachByoChart: (input: unknown) => attachByoChart(input),
}));

vi.mock("@/components/repository-selector", () => ({
	RepositorySelector: ({
		value,
		onChange,
	}: {
		value: string;
		onChange: (v: string) => void;
	}) => (
		<input
			aria-label="Chart repository"
			value={value}
			onChange={(e) => onChange(e.target.value)}
		/>
	),
}));

const { toast } = vi.hoisted(() => ({
	toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
	attachByoChart.mockReset();
	attachByoChart.mockResolvedValue({ ok: true, id: "payments" });
	toast.success.mockReset();
	toast.error.mockReset();
});

function renderDialog() {
	return render(
		<ByoChartDialog
			open
			onOpenChange={() => {}}
			projectId="proj-1"
			environmentId="env-1"
		/>,
	);
}

const next = () => screen.getByRole("button", { name: /next/i });

describe("ByoChartDialog — OCI source", () => {
	it("attaches an OCI chart as a single reference with no chart path", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("radio", { name: /OCI registry/i }));
		await user.click(next());

		await user.type(
			screen.getByLabelText(/chart reference/i),
			"oci://ghcr.io/acme/payments",
		);
		// No "Chart path" step exists on this branch.
		expect(screen.queryByLabelText(/chart path/i)).not.toBeInTheDocument();
		await user.click(next());

		await user.type(screen.getByLabelText(/chart version/i), "1.4.2");
		await user.click(next());
		await user.click(screen.getByRole("button", { name: /attach chart/i }));

		await waitFor(() => expect(attachByoChart).toHaveBeenCalledTimes(1));
		const input = attachByoChart.mock.calls[0][0];
		expect(input).toMatchObject({
			projectId: "proj-1",
			environmentId: "env-1",
			id: "payments",
			repoUrl: "oci://ghcr.io/acme/payments",
			ref: "1.4.2",
			namespace: "default",
		});
		// Omitted, not empty — attachByoChart stores chart_path null for OCI, and an empty string
		// would resolve to a git chart with a missing path.
		expect(input).not.toHaveProperty("chartPath");
	});

	it("defaults the chart version to * (latest), not HEAD", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("radio", { name: /OCI registry/i }));
		await user.click(next());
		await user.type(
			screen.getByLabelText(/chart reference/i),
			"oci://ghcr.io/acme/payments",
		);
		await user.click(next());
		await user.click(next()); // leave the version blank
		await user.click(screen.getByRole("button", { name: /attach chart/i }));

		await waitFor(() => expect(attachByoChart).toHaveBeenCalledTimes(1));
		expect(attachByoChart.mock.calls[0][0].ref).toBe("*");
	});

	it("blocks advancing on a reference that names no chart, and says why", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("radio", { name: /OCI registry/i }));
		await user.click(next());

		// Host only — resolveByoChartInstall needs a host AND a chart segment to address a chart.
		await user.type(screen.getByLabelText(/chart reference/i), "oci://ghcr.io");
		await user.click(next());

		// Still on the Registry step, with the reason on screen — not a dead Next button that never
		// explains itself.
		expect(await screen.findByText(/including the chart name/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/chart reference/i)).toBeInTheDocument();

		await user.type(screen.getByLabelText(/chart reference/i), "/acme/payments");
		await user.click(next());
		expect(await screen.findByLabelText(/chart version/i)).toBeInTheDocument();
	});

	it("warns that OCI charts can't be safety-scanned", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("radio", { name: /OCI registry/i }));
		await user.click(next());
		await user.type(
			screen.getByLabelText(/chart reference/i),
			"oci://ghcr.io/acme/payments",
		);
		await user.click(next());
		await user.click(next());

		expect(screen.getByText(/isn't available for OCI charts/i)).toBeInTheDocument();
	});
});

describe("ByoChartDialog — git source", () => {
	it("still attaches a git chart with its path and ref", async () => {
		const user = userEvent.setup();
		renderDialog();

		// Git is the default source.
		await user.click(next());
		await user.type(
			screen.getByLabelText(/chart repository/i),
			"https://github.com/acme/payments-helm",
		);
		await user.click(next());
		await user.type(screen.getByLabelText(/chart path/i), "charts/payments");
		await user.click(next());
		await user.type(screen.getByLabelText(/git ref/i), "main");
		await user.click(next());
		await user.click(screen.getByRole("button", { name: /attach chart/i }));

		await waitFor(() => expect(attachByoChart).toHaveBeenCalledTimes(1));
		expect(attachByoChart.mock.calls[0][0]).toMatchObject({
			repoUrl: "https://github.com/acme/payments-helm",
			chartPath: "charts/payments",
			ref: "main",
			id: "payments-helm",
		});
	});
});
