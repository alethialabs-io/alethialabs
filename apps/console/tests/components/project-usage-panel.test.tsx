// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6825 (D-31) — the per-project Usage panel. Its secondary reads (AI credits, the clusters and
// estimated-cost read) fail on their own, and a failure used to render "—", the same as "nothing
// to report": under a money label that reads as "costs nothing". Each fact now ends in one of four
// renders — the value, a skeleton, a refusal, or "Couldn't load" with a retry that asks again.

import { formatMinutes, formatMonthlyRate } from "@repo/format";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ProjectAiUsage,
	ProjectResourceCountsReport,
	ProjectUsageReport,
	UsageOverTime,
} from "@/lib/rpc/procedures/usage";

vi.mock("@/lib/rpc/client", async () => ({
	orpc: (await import("./settings/billing-rpc-fake")).fakeOrpc,
}));
// The over-time window and metric are URL state (R6 C-32): the link the panel reads is `url.search`.
const url = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
	useSearchParams: () => new URLSearchParams(url.search),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({ useActiveOrgSlug: () => "acme" }));

import { ProjectUsagePanel } from "@/components/settings/usage/project-usage-panel";
import { failed, reads, refused, renderWithReads, resetReads } from "./settings/billing-rpc-fake";

const usage: ProjectUsageReport = {
	jobMinutes: 135,
	jobCount: 12,
	runningJobs: 2,
	periodStart: "2026-06-01T00:00:00.000Z",
	periodEnd: "2026-07-01T00:00:00.000Z",
};
const resources: ProjectResourceCountsReport = { clusters: 3, estimatedMonthlyCost: 412.5 };
const ai: ProjectAiUsage = {
	creditsThisPeriod: 1250,
	periodStart: "2026-06-01T00:00:00.000Z",
	periodEnd: "2026-07-01T00:00:00.000Z",
};
const overTime: UsageOverTime = {
	series: [{ date: "2026-06-01", runnerMinutes: 135, jobs: 12, aiCredits: 1250 }],
	totals: { runnerMinutes: 135, jobs: 12, aiCredits: 1250 },
};

/** The `<dd>` of the fact whose term is `label`. */
function factValue(label: string): HTMLElement {
	const term = screen.getByText(label).closest("dt");
	const value = term?.nextElementSibling;
	if (!(value instanceof HTMLElement)) throw new Error(`no value for ${label}`);
	return value;
}

beforeEach(() => {
	url.search = "";
	resetReads();
	reads.project.mockResolvedValue(usage);
	reads.projectOverTime.mockResolvedValue(overTime);
});

describe("ProjectUsagePanel — each fact's read ends in its own render", () => {
	it("renders every fact from its read", async () => {
		reads.projectResources.mockResolvedValue(resources);
		reads.projectAi.mockResolvedValue(ai);
		renderWithReads(<ProjectUsagePanel projectId="p1" />);

		await screen.findByText("Runner job-minutes");
		expect(factValue("Runner job-minutes")).toHaveTextContent(formatMinutes(135));
		await waitFor(() =>
			expect(factValue("Estimated cloud spend for this project")).toHaveTextContent(
				formatMonthlyRate(412.5),
			),
		);
		expect(factValue("Clusters")).toHaveTextContent("3");
		expect(factValue("AI credits used")).toHaveTextContent("1,250");
	});

	it("a failed cost read says so and retries, instead of a dash", async () => {
		reads.projectResources.mockRejectedValue(failed());
		reads.projectAi.mockResolvedValue(ai);
		const user = userEvent.setup();
		renderWithReads(<ProjectUsagePanel projectId="p1" />);

		const retry = await screen.findByRole("button", {
			name: "Retry loading estimated cloud spend",
		});
		const cost = factValue("Estimated cloud spend for this project");
		expect(within(cost).getByText("Couldn't load")).toBeInTheDocument();
		expect(cost).not.toHaveTextContent("—");
		expect(factValue("Clusters")).toHaveTextContent("Couldn't load");

		reads.projectResources.mockReset();
		reads.projectResources.mockResolvedValue(resources);
		await user.click(retry);
		await waitFor(() =>
			expect(factValue("Estimated cloud spend for this project")).toHaveTextContent(
				formatMonthlyRate(412.5),
			),
		);
	});

	it("a failed AI read says so with a retry, and leaves the rest of the page standing", async () => {
		reads.projectResources.mockResolvedValue(resources);
		reads.projectAi.mockRejectedValue(failed());
		renderWithReads(<ProjectUsagePanel projectId="p1" />);

		expect(
			await screen.findByRole("button", { name: "Retry loading AI credits" }),
		).toBeInTheDocument();
		expect(factValue("Runner job-minutes")).toHaveTextContent(formatMinutes(135));
		await waitFor(() => expect(factValue("Clusters")).toHaveTextContent("3"));
	});

	it("a refused read is a calm note with no retry", async () => {
		reads.projectResources.mockResolvedValue(resources);
		reads.projectAi.mockRejectedValue(refused("FORBIDDEN"));
		renderWithReads(<ProjectUsagePanel projectId="p1" />);

		await waitFor(() =>
			expect(factValue("AI credits used")).toHaveTextContent("Not available to you"),
		);
		expect(screen.queryByRole("button", { name: "Retry loading AI credits" })).toBeNull();
	});

	it("a read that has not answered is a skeleton, not a dash", async () => {
		reads.projectResources.mockResolvedValue(resources);
		// projectAi keeps the reset default: it never answers.
		renderWithReads(<ProjectUsagePanel projectId="p1" />);

		await screen.findByText("Runner job-minutes");
		const value = factValue("AI credits used");
		expect(value.querySelector('[data-state="loading"]')).not.toBeNull();
		expect(value).not.toHaveTextContent("—");
	});
});
