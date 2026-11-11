// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6541 — the BYO admission drawer shows the latest deploy's violation report BEFORE refusal can be
// turned on, and turning it on asks for an acknowledgement of that report.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, FakeHandler>,
	set: vi.fn(async () => undefined),
	status: vi.fn(),
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers).orpc };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/server/actions/projects", () => ({ setByoAdmissionEnforce: h.set }));
// The drawer reads `environments.byoAdmissionReport`; `h.status` stands in for the deploy status that
// procedure reduces, so each test states the report as the Deploy tab would have it.
h.handlers["environments.byoAdmissionReport"] = async (input) => {
	const { projectId, environmentId } = z.object({ projectId: z.string(), environmentId: z.string() }).parse(input);
	const st = await h.status(projectId, environmentId);
	return { environmentId, report: st.byoAdmission, reportAt: st.byoAdmissionReportAt };
};

import { ByoAdmissionSheet, byoAdmissionFormSchema } from "@/components/environments/byo-admission-sheet";
import { EMPTY_GITOPS_DEPLOY_STATUS } from "@/lib/gitops/deploy-status";
import type { ByoAdmissionNamespaceReport } from "@/types/jsonb.types";

/** Every kind checked, Pod Security previewed: a complete report for one warn namespace. */
const CHECKED: ByoAdmissionNamespaceReport["checks"] = [
	{ kind: "Service", state: "checked" },
	{ kind: "Ingress", state: "checked" },
	{ kind: "Secret", state: "checked" },
	{ kind: "PodSecurity", state: "checked" },
];

/** A status whose latest deploy reported `byoAdmission`, two days before now. */
function reported(byoAdmission: ByoAdmissionNamespaceReport[]) {
	return {
		...EMPTY_GITOPS_DEPLOY_STATUS,
		byoAdmission,
		byoAdmissionReportAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
	};
}

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";

/** Opens the drawer for an environment whose setting is `enforce`. */
function open(enforce: boolean) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<ByoAdmissionSheet open onOpenChange={() => {}} projectId={PROJECT} envId={ENV} envName="production" enforce={enforce} />
		</QueryClientProvider>,
	);
}

describe("ByoAdmissionSheet", () => {
	it("shows each namespace's findings before the switch is touched", async () => {
		h.status.mockResolvedValue(
			reported([
				{ namespace: "byo-api", charts: ["api"], mode: "warn", reason: "chart-history", findings: ['Service "web": spec.type is LoadBalancer'], checks: CHECKED },
			]),
		);
		open(false);
		expect(await screen.findByText('Service "web": spec.type is LoadBalancer')).toBeDefined();
		expect(screen.getByText("byo-api")).toBeDefined();
		expect(h.status).toHaveBeenCalledWith(PROJECT, ENV);
		expect(screen.getByRole("switch", { name: "Refuse in every BYO namespace" })).toHaveAttribute("aria-checked", "false");
		// The report's date, and what no report covers.
		expect(screen.getByText(/latest deploy · /)).toBeDefined();
		expect(screen.getByText(/A CronJob between runs, a workload scaled to zero, and a chart attached after that deploy are not in it/)).toBeDefined();
	});

	it("an incomplete report says what was not checked and blocks turning refusal on", async () => {
		h.set.mockClear();
		h.status.mockResolvedValue(
			reported([
				{
					namespace: "byo-api",
					charts: ["api"],
					mode: "warn",
					reason: "chart-history",
					checks: [
						{ kind: "Service", state: "failed" },
						{ kind: "Ingress", state: "checked" },
						{ kind: "Secret", state: "checked" },
						{ kind: "PodSecurity", state: "checked" },
					],
				},
			]),
		);
		open(false);
		expect(await screen.findByText("Could not be checked: Services.")).toBeDefined();
		expect(screen.queryByText("Nothing found that refusal would refuse.")).toBeNull();
		expect(screen.getByText(/This report is incomplete/)).toBeDefined();
		fireEvent.click(screen.getByRole("switch", { name: "Refuse in every BYO namespace" }));
		expect(screen.getByRole("alert")).toHaveTextContent("only over a complete report");
		expect(screen.queryByRole("checkbox")).toBeNull();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		expect(h.set).not.toHaveBeenCalled();
	});

	it("a report from a runner that recorded no checks is not read as clean", async () => {
		h.status.mockResolvedValue(reported([{ namespace: "byo-api", charts: ["api"], mode: "warn", reason: "chart-history" }]));
		open(false);
		expect(await screen.findByText(/Could not be checked: Services, Ingresses, Secrets, Pod Security/)).toBeDefined();
		fireEvent.click(screen.getByRole("switch", { name: "Refuse in every BYO namespace" }));
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});

	it("turning refusal OFF is never blocked by the report", async () => {
		h.set.mockClear();
		h.status.mockResolvedValue(EMPTY_GITOPS_DEPLOY_STATUS);
		open(true);
		await screen.findByText("No admission report yet");
		fireEvent.click(screen.getByRole("switch", { name: "Refuse in every BYO namespace" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(h.set).toHaveBeenCalledWith(PROJECT, ENV, false));
	});

	it("says there is no report yet rather than showing an empty one", async () => {
		h.status.mockResolvedValue(EMPTY_GITOPS_DEPLOY_STATUS);
		open(false);
		expect(await screen.findByText("No admission report yet")).toBeDefined();
	});

	it("turning refusal on is not saved until the report is acknowledged", async () => {
		h.set.mockClear();
		h.status.mockResolvedValue(
			reported([{ namespace: "byo-api", charts: ["api"], mode: "warn", reason: "chart-history", findings: ["x"], checks: CHECKED }]),
		);
		open(false);
		await screen.findByText("byo-api");
		fireEvent.click(screen.getByRole("switch", { name: "Refuse in every BYO namespace" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Confirm you have read");
		expect(h.set).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("checkbox", { name: /I have read the 1 finding above/ }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(h.set).toHaveBeenCalledWith(PROJECT, ENV, true));
	});
});

describe("byoAdmissionFormSchema", () => {
	it("asks for the acknowledgement only when turning refusal on", () => {
		expect(byoAdmissionFormSchema(false, true).safeParse({ enforce: true, acknowledged: false }).success).toBe(false);
		expect(byoAdmissionFormSchema(false, true).safeParse({ enforce: true, acknowledged: true }).success).toBe(true);
		expect(byoAdmissionFormSchema(true, true).safeParse({ enforce: false, acknowledged: false }).success).toBe(true);
		expect(byoAdmissionFormSchema(true, true).safeParse({ enforce: true, acknowledged: false }).success).toBe(true);
	});

	it("refuses turning refusal on over an incomplete report, even acknowledged; never the off switch", () => {
		expect(byoAdmissionFormSchema(false, false).safeParse({ enforce: true, acknowledged: true }).success).toBe(false);
		expect(byoAdmissionFormSchema(true, false).safeParse({ enforce: false, acknowledged: false }).success).toBe(true);
	});
});
