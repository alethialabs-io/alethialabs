// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component test for the scope-aware Activity feed: when pinned to a project, the feed forces the
// project's id onto the query, hides the redundant Project facet + Export, and shows the scope
// caption. At the org scope the Project facet is back and no scope is forced.

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A flat list of projects (projects) under the org, as the projects store holds them.
const PROJECTS = [
	{ id: "s1", project_name: "api", slug: "api" },
	{ id: "s2", project_name: "web", slug: "web" },
];

vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
	useWorkspaceStore: (sel: (s: unknown) => unknown) =>
		sel({ entitlements: { quotas: { activityRetentionDays: 7 } } }),
}));
vi.mock("@/lib/stores/use-projects-store", () => ({
	useProjectsStore: (sel: (s: unknown) => unknown) =>
		sel({ projects: PROJECTS, fetchProjects: vi.fn() }),
}));
vi.mock("@/components/settings/enterprise-gate", () => ({
	useEntitlement: () => false,
}));
vi.mock("@/components/org/upgrade-org-sheet", () => ({ UpgradeOrgSheet: () => null }));
vi.mock("@/app/server/actions/members", () => ({ getMembers: vi.fn() }));
vi.mock("@/app/server/actions/activity", () => ({
	getActivityLog: vi.fn(),
	getActivityExportCsv: vi.fn(),
}));

import { ActivityLog } from "@/components/settings/activity/activity-log";
import { getMembers } from "@/app/server/actions/members";
import { getActivityLog } from "@/app/server/actions/activity";

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getMembers).mockResolvedValue([]);
	vi.mocked(getActivityLog).mockResolvedValue({ rows: [], nextCursor: null });
});

describe("ActivityLog — project scope", () => {
	it("forces the project's id, hides the Project facet + Export, and captions the scope", async () => {
		render(<ActivityLog projectId="s1" />);

		// Forced scope: the first query carries just the project id.
		await waitFor(() => expect(getActivityLog).toHaveBeenCalled());
		expect(vi.mocked(getActivityLog).mock.calls[0][0]?.resourceIds).toEqual(["s1"]);

		// Redundant controls are gone; the caption names the project.
		expect(screen.queryByText("Project")).toBeNull();
		expect(screen.queryByRole("button", { name: /export csv/i })).toBeNull();
		expect(await screen.findByText(/activity in/i)).toBeInTheDocument();
		expect(screen.getByText("api")).toBeInTheDocument();
	});
});

describe("ActivityLog — org scope", () => {
	it("keeps the Project facet and forces no resource scope", async () => {
		render(<ActivityLog />);

		await waitFor(() => expect(getActivityLog).toHaveBeenCalled());
		expect(vi.mocked(getActivityLog).mock.calls[0][0]?.resourceIds).toBeUndefined();

		expect(screen.getByText("Project")).toBeInTheDocument();
		expect(screen.queryByText(/activity in/i)).toBeNull();
	});
});
