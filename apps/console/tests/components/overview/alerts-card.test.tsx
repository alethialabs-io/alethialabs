// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The overview's Alerts card (#6118: read over `overview.alerts`, prefetched on the server).
//
// Before this the card read `getAlertsBootstrap` in an effect, and a FAILED read set the card to
// "No recent alerts." — telling the viewer something false about their alerts. Pending, forbidden,
// plan-gated, empty, failed and answered are now six distinct renders (RUBRIC B3/B4).

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OverviewAlerts } from "@/lib/rpc/procedures/overview";

vi.mock("@/lib/rpc/client", async () => ({ orpc: (await import("./rpc-fake")).fakeOrpc }));
vi.mock("@/components/org/upgrade-sheet-provider", () => ({
	useUpgradeSheet: () => ({ openUpgrade: vi.fn() }),
}));

import { AlertsCard } from "@/components/overview/alerts-card";
import { fakeOrpc, forbidden, never, reads, renderWithReads, testClient } from "./rpc-fake";

const delivery = {
	id: "d1",
	event_key: "job.failed",
	status: "failed" as const,
	title: "Deploy failed on payments",
	attempts: 1,
	last_error: null,
	created_at: "2026-10-20T10:00:00.000Z",
	sent_at: null,
};

/** Renders the card with `data` already in the cache — what the page's prefetch hands it. */
function renderAnswered(data: OverviewAlerts) {
	const client = testClient();
	client.setQueryData(fakeOrpc.overview.alerts.queryKey(), data);
	return renderWithReads(<AlertsCard orgSlug="acme" />, client);
}

beforeEach(() => {
	reads.alerts.mockReset();
	reads.alerts.mockImplementation(never);
});

describe("AlertsCard", () => {
	it("answered: lists the deliveries, and reads nothing on mount (B1)", () => {
		renderAnswered({ alerting: true, deliveries: [delivery] });
		expect(screen.getByText("Deploy failed on payments")).toBeInTheDocument();
		expect(screen.getByText("1 recent")).toBeInTheDocument();
		expect(reads.alerts).not.toHaveBeenCalled();
	});

	it("empty: says so only when the read answered with no deliveries", () => {
		renderAnswered({ alerting: true, deliveries: [] });
		expect(screen.getByText("No recent alerts.")).toBeInTheDocument();
	});

	it("plan-gated: the upsell, not the rows and not the empty copy", () => {
		renderAnswered({ alerting: false, deliveries: [delivery] });
		expect(screen.getByText("Alerting is a Pro feature")).toBeInTheDocument();
		expect(screen.queryByText("Deploy failed on payments")).not.toBeInTheDocument();
		expect(screen.queryByText("No recent alerts.")).not.toBeInTheDocument();
	});

	it("pending: the skeleton — never the empty copy (B3)", () => {
		const { container } = renderWithReads(<AlertsCard orgSlug="acme" />);
		expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
		expect(screen.queryByText("No recent alerts.")).not.toBeInTheDocument();
	});

	it("forbidden: its own render, without a retry, and the refusal is not retried", async () => {
		reads.alerts.mockRejectedValue(forbidden());
		const { container } = renderWithReads(<AlertsCard orgSlug="acme" />);
		expect(await screen.findByText("You don't have access to alerts.")).toBeInTheDocument();
		expect(container.querySelector("[data-slot='region-error']")).toBeNull();
		expect(screen.queryByText("No recent alerts.")).not.toBeInTheDocument();
		expect(reads.alerts).toHaveBeenCalledTimes(1);
	});

	it("failed: a region error with a retry — never 'No recent alerts.' (B4)", async () => {
		reads.alerts.mockRejectedValue(new Error("boom"));
		const { container } = renderWithReads(<AlertsCard orgSlug="acme" />);
		expect(await screen.findByText("Couldn't load alerts")).toBeInTheDocument();
		expect(container.querySelector("[data-slot='region-error']")).not.toBeNull();
		expect(screen.queryByText("No recent alerts.")).not.toBeInTheDocument();

		reads.alerts.mockResolvedValue({ alerting: true, deliveries: [delivery] });
		fireEvent.click(screen.getByRole("button", { name: /try again/i }));
		await waitFor(() => expect(screen.getByText("Deploy failed on payments")).toBeInTheDocument());
	});
});
