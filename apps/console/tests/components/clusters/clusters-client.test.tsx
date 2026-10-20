// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6122 (RUBRIC B3/B4): the clusters grid's five renders are five different things. Pending is the
// skeleton, never the empty state; a refusal says the viewer lacks access and offers no retry; a
// failure says it failed and offers one; no clusters is the empty state; a refresh that fails after
// data arrived keeps the cards. The project drilldown shows only its project's clusters.

import { ORPCError } from "@orpc/client";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	const query: Record<string, unknown> = {};
	return { query };
});

vi.mock("@/lib/query/use-clusters-query", () => ({ useClustersQuery: () => h.query }));
vi.mock("@/lib/stores/use-workspace-store", () => ({ useActiveOrgSlug: () => "acme" }));
vi.mock("@/components/clusters/cluster-card", () => ({
	ClusterCard: ({ data }: { data: { project_cluster: { id: string } } }) => (
		<div data-testid="cluster-card">{data.project_cluster.id}</div>
	),
}));

import { ClustersClient } from "@/app/(private)/[org]/~/clusters/clusters-client";

/** A list entry: project `projectId`'s cluster `clusterId`. */
function cluster(clusterId: string, projectId: string) {
	return { id: projectId, project_cluster: { id: clusterId } };
}

const refetch = vi.fn();

beforeEach(() => {
	refetch.mockReset();
	h.query = { data: undefined, isError: false, error: null, refetch };
});

describe("ClustersClient", () => {
	it("pending is the skeleton — not the empty state", () => {
		const { container } = render(<ClustersClient />);
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(screen.queryByText(/No clusters/)).toBeNull();
	});

	it("a refusal says the viewer lacks access, with nothing to retry", () => {
		h.query = { ...h.query, isError: true, error: new ORPCError("FORBIDDEN", { defined: true, status: 403 }) };
		render(<ClustersClient />);
		expect(screen.getByText("You don't have access to clusters")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
		expect(screen.queryByText(/No clusters/)).toBeNull();
	});

	it("a failure is an error with a retry — not the empty state", async () => {
		h.query = { ...h.query, isError: true, error: new Error("boom") };
		render(<ClustersClient />);
		expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load clusters");
		await userEvent.click(screen.getByRole("button", { name: /try again/i }));
		expect(refetch).toHaveBeenCalledOnce();
		expect(screen.queryByText(/No clusters/)).toBeNull();
	});

	it("no clusters is the empty state", () => {
		h.query = { ...h.query, data: [] };
		render(<ClustersClient />);
		expect(screen.getByText("No clusters under management")).toBeInTheDocument();
	});

	it("renders one card per cluster — two environments of one project are two cards", () => {
		h.query = { ...h.query, data: [cluster("c1", "p1"), cluster("c2", "p1"), cluster("c3", "p2")] };
		render(<ClustersClient />);
		expect(screen.getAllByTestId("cluster-card").map((el) => el.textContent)).toEqual(["c1", "c2", "c3"]);
	});

	it("keeps the cards when a refresh fails after data arrived", () => {
		h.query = { ...h.query, data: [cluster("c1", "p1")], isError: true, error: new Error("boom") };
		render(<ClustersClient />);
		expect(screen.getAllByTestId("cluster-card")).toHaveLength(1);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("the project drilldown shows only its project's clusters, and its own empty state", () => {
		h.query = { ...h.query, data: [cluster("c1", "p1"), cluster("c2", "p2")] };
		const { unmount } = render(<ClustersClient projectId="p2" />);
		expect(screen.getAllByTestId("cluster-card").map((el) => el.textContent)).toEqual(["c2"]);
		unmount();
		render(<ClustersClient projectId="p3" />);
		expect(screen.getByText("This project has no clusters yet")).toBeInTheDocument();
	});
});
