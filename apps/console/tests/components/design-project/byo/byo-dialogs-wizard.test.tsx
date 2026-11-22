// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The two BYO attach dialogs on the shared wizard engine (#6841, WIZ-W3):
//
//   · the dialog is open exactly while the URL says `?wizard=byo-chart|byo-iac`: the canvas's
//     request opens that URL, a URL that names the wizard opens the dialog on its own (the return
//     from linking a git provider), and closing removes it;
//   · the return to the same URL — a reload, or the provider link coming back — restores the step
//     and what was typed, and says so;
//   · a server field refusal takes the person to the step that shows the field;
//   · neither definition keeps the Helm values or the tfvars in a draft. Completeness and the
//     credential-shaped-key check are tests/lib/wizard/definitions.test.ts's, which finds both
//     definitions by their `*.wizard.ts` names.
//
// "A reload" is an unmount and a fresh render over the same query string and the same tab storage,
// which is all a reload leaves the page (`byo-wizard-harness.ts`).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { attachByoChart, attachIacSource } = vi.hoisted(() => ({
	attachByoChart: vi.fn(),
	attachIacSource: vi.fn(),
}));
vi.mock("@/app/server/actions/byo-charts", () => ({
	attachByoChartAction: (input: unknown) => attachByoChart(input),
}));
vi.mock("@/app/server/actions/byo-iac", () => ({
	attachIacSourceAction: (input: unknown) => attachIacSource(input),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/wizard/location", async (importOriginal) => {
	const harness = await import("@/tests/components/design-project/byo/byo-wizard-harness");
	return {
		...(await importOriginal<typeof import("@/lib/wizard/location")>()),
		useWizardEnvironment: harness.useTestWizardEnvironment,
	};
});
// The git-provider selector, as a plain input named by its label; its auth and fetch are not under test.
vi.mock("@/components/repository-selector", () => ({
	RepositorySelector: ({
		value,
		onChange,
		label,
	}: {
		value: string;
		onChange: (v: string) => void;
		label?: string;
	}) => <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />,
}));

import {
	ByoChartDialog,
	HELM_VALUES_NOT_KEPT,
} from "@/components/design-project/byo/byo-chart-dialog";
import { BYO_CHART_WIZARD_ID, byoChartWizard } from "@/components/design-project/byo/byo-chart.wizard";
import {
	ByoIacDialog,
	EXAMPLE_IAC_PATH,
	EXAMPLE_IAC_REPO_URL,
	VARIABLES_NOT_KEPT,
} from "@/components/design-project/byo/byo-iac-dialog";
import { BYO_IAC_WIZARD_ID, byoIacWizard } from "@/components/design-project/byo/byo-iac.wizard";
import { draftTopLevelKeys } from "@/lib/wizard/define";
import {
	resetTestPage,
	setTestSearch,
	testParam,
} from "@/tests/components/design-project/byo/byo-wizard-harness";

beforeEach(() => {
	resetTestPage();
	attachByoChart.mockReset();
	attachByoChart.mockResolvedValue({ ok: true, data: { id: "podinfo" } });
	attachIacSource.mockReset();
	attachIacSource.mockResolvedValue({ ok: true, data: { id: "src-1" } });
});

/** Renders the chart dialog with the canvas's request `open`. */
function renderChart(open: boolean, onOpenChange: (open: boolean) => void = () => {}) {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<ByoChartDialog
				open={open}
				onOpenChange={onOpenChange}
				projectId="proj-1"
				environmentId="env-1"
			/>
		</QueryClientProvider>,
	);
}

/** Renders the IaC dialog with the canvas's request `open`. */
function renderIac(open: boolean, onOpenChange: (open: boolean) => void = () => {}) {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<ByoIacDialog open={open} onOpenChange={onOpenChange} projectId="proj-1" environmentId="env-1" />
		</QueryClientProvider>,
	);
}

const next = () => screen.getByRole("button", { name: /^next$/i });

describe("the BYO wizard definitions", () => {
	it("opens under the ids a canvas `byo` seed names", () => {
		expect([BYO_CHART_WIZARD_ID, BYO_IAC_WIZARD_ID]).toEqual(["byo-chart", "byo-iac"]);
	});

	it("keeps neither the Helm values nor the tfvars in a draft", () => {
		const chartDraft = byoChartWizard.draft;
		const iacDraft = byoIacWizard.draft;
		if (chartDraft === null || iacDraft === null) throw new Error("both wizards keep a draft");
		expect(draftTopLevelKeys(chartDraft.schema)).not.toContain("valuesYaml");
		expect(draftTopLevelKeys(iacDraft.schema)).not.toContain("variables");
	});
});

describe("the dialog's open state is the URL", () => {
	it("the canvas's request opens ?wizard=byo-chart and drops the one-shot ?attachChart=1", async () => {
		setTestSearch("attachChart=1&tab=board");
		renderChart(true);

		expect(await screen.findByRole("dialog")).toBeInTheDocument();
		expect(testParam("wizard")).toBe("byo-chart");
		expect(testParam("attachChart")).toBeNull();
		// A param the dialog does not own is left alone.
		expect(testParam("tab")).toBe("board");
	});

	it("a URL that names the wizard opens it with no request, and tells the canvas", async () => {
		const onOpenChange = vi.fn();
		setTestSearch("wizard=byo-iac");
		renderIac(false, onOpenChange);

		expect(await screen.findByRole("dialog")).toBeInTheDocument();
		expect(await screen.findByLabelText("Module repository")).toBeInTheDocument();
		expect(onOpenChange).toHaveBeenCalledWith(true);
	});

	it("closing removes the wizard and its step from the URL, and tells the canvas", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		renderChart(true, onOpenChange);
		await screen.findByRole("button", { name: /^next$/i });

		await user.keyboard("{Escape}");

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(testParam("wizard")).toBeNull();
		expect(testParam("step")).toBeNull();
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("Back in the browser (the URL losing ?wizard=) closes it", async () => {
		renderIac(true);
		await screen.findByLabelText("Module repository");

		setTestSearch("");

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});

describe("returning to the same URL restores the step and what was typed", () => {
	it("the chart wizard comes back on its step with the OCI reference it had", async () => {
		const user = userEvent.setup();
		const first = renderChart(true);
		await screen.findByRole("button", { name: /^next$/i });
		await user.click(screen.getByRole("radio", { name: /OCI registry/i }));
		await user.click(next());
		await user.type(
			await screen.findByLabelText(/chart reference/i),
			"oci://ghcr.io/stefanprodan/charts/podinfo",
		);
		await user.click(next());
		await screen.findByLabelText(/chart version/i);
		expect(testParam("step")).toBe("ref");
		first.unmount();

		// The provider link (or a reload) comes back to the URL it left; the canvas asks for nothing.
		renderChart(false);

		expect(await screen.findByLabelText(/chart version/i)).toBeInTheDocument();
		expect(screen.getByText(/restored your draft/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /^back$/i }));
		expect(await screen.findByLabelText(/chart reference/i)).toHaveValue(
			"oci://ghcr.io/stefanprodan/charts/podinfo",
		);
	});

	it("the chart wizard does not keep the Helm values, and says so where they are typed", async () => {
		const user = userEvent.setup();
		renderChart(true);
		await screen.findByRole("button", { name: /^next$/i });
		await user.click(screen.getByRole("radio", { name: /OCI registry/i }));
		await user.click(next());
		await user.type(await screen.findByLabelText(/chart reference/i), "oci://ghcr.io/org/chart");
		await user.click(next());
		await user.click(next());

		expect(await screen.findByText(HELM_VALUES_NOT_KEPT)).toBeInTheDocument();
	});

	it("the IaC wizard comes back on Path & ref with the repository and path, and asks for the variables again", async () => {
		const user = userEvent.setup();
		const first = renderIac(true);
		await user.type(await screen.findByLabelText("Module repository"), EXAMPLE_IAC_REPO_URL);
		await user.click(next());
		await user.type(await screen.findByLabelText(/root-module path/i), EXAMPLE_IAC_PATH);
		await user.click(next());
		await user.click(await screen.findByRole("button", { name: /add/i }));
		await user.type(screen.getByLabelText(/variable 1 name/i), "drift_marker");
		await user.click(screen.getByRole("button", { name: /^back$/i }));
		await screen.findByLabelText(/root-module path/i);
		first.unmount();

		renderIac(false);

		expect(await screen.findByLabelText(/root-module path/i)).toHaveValue(EXAMPLE_IAC_PATH);
		expect(screen.getByText(/restored your draft/i)).toBeInTheDocument();
		await user.click(next());
		expect(await screen.findByText(VARIABLES_NOT_KEPT)).toBeInTheDocument();
		expect(screen.queryByLabelText(/variable 1 name/i)).toBeNull();
	});
});

describe("a server field refusal lands on the step that shows the field", () => {
	it("the chart's refused repository URL takes the person back to Registry, with the reason", async () => {
		const reason = "This registry is not reachable from the cluster.";
		attachByoChart.mockResolvedValue({
			ok: false,
			error: { kind: "validation", message: "Check the chart.", fields: { repoUrl: [reason] } },
		});
		const user = userEvent.setup();
		renderChart(true);
		await screen.findByRole("button", { name: /^next$/i });
		await user.click(screen.getByRole("radio", { name: /OCI registry/i }));
		await user.click(next());
		await user.type(await screen.findByLabelText(/chart reference/i), "oci://ghcr.io/org/chart");
		await user.click(next());
		await user.click(next());
		await user.click(await screen.findByRole("button", { name: /attach chart/i }));

		expect(await screen.findByText(reason)).toBeInTheDocument();
		expect(screen.getByLabelText(/chart reference/i)).toHaveAttribute("aria-invalid", "true");
		expect(testParam("step")).toBe("registry");
	});

	it("the chart's refused id lands on the Review step's name", async () => {
		const reason = "A chart with this name is already attached.";
		attachByoChart.mockResolvedValue({
			ok: false,
			error: { kind: "validation", message: "Check the chart.", fields: { id: [reason] } },
		});
		const user = userEvent.setup();
		renderChart(true);
		await screen.findByRole("button", { name: /^next$/i });
		await user.click(screen.getByRole("radio", { name: /OCI registry/i }));
		await user.click(next());
		await user.type(await screen.findByLabelText(/chart reference/i), "oci://ghcr.io/org/chart");
		await user.click(next());
		await user.click(next());
		await user.click(await screen.findByRole("button", { name: /attach chart/i }));

		expect(await screen.findByText(reason)).toBeInTheDocument();
		expect(screen.getByLabelText(/^name$/i)).toHaveAttribute("aria-invalid", "true");
	});

	it("the IaC source's refused repository takes the person back to Repository", async () => {
		const reason = "Enter the module's git repository URL.";
		attachIacSource.mockResolvedValue({
			ok: false,
			error: { kind: "validation", message: "Check the module.", fields: { repoUrl: [reason] } },
		});
		const user = userEvent.setup();
		renderIac(true);
		await user.type(await screen.findByLabelText("Module repository"), EXAMPLE_IAC_REPO_URL);
		await user.click(next());
		await user.click(await screen.findByRole("button", { name: /^next$/i }));
		await user.click(await screen.findByRole("button", { name: /^next$/i }));
		await user.click(await screen.findByRole("button", { name: /attach source/i }));

		expect(await screen.findByText(reason)).toBeInTheDocument();
		expect(screen.getByLabelText("Module repository")).toBeInTheDocument();
		expect(testParam("step")).toBe("repository");
	});
});

describe("a landed attach", () => {
	it("closes the dialog and leaves no wizard param behind", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		renderIac(true, onOpenChange);
		await user.type(await screen.findByLabelText("Module repository"), EXAMPLE_IAC_REPO_URL);
		await user.click(next());
		await user.click(await screen.findByRole("button", { name: /^next$/i }));
		await user.click(await screen.findByRole("button", { name: /^next$/i }));
		await user.click(await screen.findByRole("button", { name: /attach source/i }));

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(testParam("wizard")).toBeNull();
		expect(testParam("step")).toBeNull();
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
