// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's switchers keep a failed read apart from an empty one (#6114).
//
// Both used to read `data ?? []`. The project switcher then said "No projects yet." about an org
// whose project list had simply failed to load, and the org switcher said "No organization found."
// about a list nobody had read. Each now renders `pending`, `ready` (the list, or its empty state),
// `error` (RegionError, with a retry) and `forbidden` (a note, no retry) as four distinct things.
// The REAL switchers are rendered and opened; only the queries behind them are stubbed.

import { ORPCError } from "@orpc/client";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readStatusOf } from "@/lib/query/read-status";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
	usePathname: () => "/acme/~/jobs",
}));
vi.mock("@/components/org/create-org-sheet", () => ({ CreateOrgSheet: () => null }));

const { projectsQuery, contextQuery } = vi.hoisted(() => ({
	projectsQuery: { current: {} as Record<string, unknown> },
	contextQuery: { current: {} as Record<string, unknown> },
}));
vi.mock("@/lib/query/use-projects-query", () => ({
	useProjectsQuery: () => projectsQuery.current,
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
	useWorkspaceContextQuery: () => contextQuery.current,
	useActiveWorkspaceOrg: () => null,
}));

import { OrgSwitcher } from "@/components/org-switcher";
import { ProjectSwitcher } from "@/components/project-switcher";

const REFUSED = new ORPCError("FORBIDDEN", { defined: true });

beforeEach(() => {
	projectsQuery.current = { data: [], isSuccess: true };
	contextQuery.current = { data: undefined };
});

describe("readStatusOf", () => {
	it("tells the four states apart, and data wins over a failed refetch", () => {
		expect(readStatusOf({ data: undefined })).toBe("pending");
		expect(readStatusOf({ data: [] })).toBe("ready");
		expect(readStatusOf({ data: undefined, isError: true, error: new Error("x") })).toBe("error");
		expect(readStatusOf({ data: undefined, isError: true, error: REFUSED })).toBe("forbidden");
		expect(readStatusOf({ data: [1], isError: true, error: new Error("x") })).toBe("ready");
	});

	it("an UNDEFINED oRPC error (a real failure with a code) is an error, not a refusal", () => {
		const real = new ORPCError("INTERNAL_SERVER_ERROR");
		expect(readStatusOf({ data: undefined, isError: true, error: real })).toBe("error");
	});
});

describe("ProjectSwitcher — read states", () => {
	/** Opens the project switcher. */
	async function open(): Promise<void> {
		render(<ProjectSwitcher />);
		await userEvent.click(screen.getByRole("button", { name: /Switch project/ }));
	}

	it("an org that answered with no projects shows the empty state", async () => {
		await open();
		expect(screen.getByText("No projects yet.")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("a failed project list renders an error with a retry, never 'No projects yet.'", async () => {
		const refetch = vi.fn(async () => undefined);
		projectsQuery.current = { data: undefined, isError: true, error: new Error("boom"), refetch };
		await open();
		expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load projects");
		expect(screen.queryByText("No projects yet.")).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("a refused project list says so with no retry", async () => {
		projectsQuery.current = { data: undefined, isError: true, error: REFUSED };
		await open();
		expect(screen.getByText(/can't list this organization's projects/)).toHaveAttribute(
			"data-state",
			"forbidden",
		);
		expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
		expect(screen.queryByText("No projects yet.")).not.toBeInTheDocument();
	});

	it("an unanswered project list is pending, not empty", async () => {
		projectsQuery.current = { data: undefined, isError: false };
		await open();
		expect(screen.getByRole("status", { name: "Loading projects" })).toBeInTheDocument();
		expect(screen.queryByText("No projects yet.")).not.toBeInTheDocument();
	});
});

describe("OrgSwitcher — read states", () => {
	/** Opens the org switcher (its chevron: the body is a link to the org home). */
	async function open(): Promise<void> {
		render(<OrgSwitcher />);
		await userEvent.click(screen.getByRole("button", { name: "Switch organization" }));
	}

	it("a failed workspace context renders an error with a retry, never 'No organization found.'", async () => {
		const refetch = vi.fn(async () => undefined);
		contextQuery.current = { data: undefined, isError: true, error: new Error("boom"), refetch };
		await open();
		expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load your organizations");
		expect(screen.queryByText("No organization found.")).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("an unanswered context is pending, and the Create action stays reachable", async () => {
		await open();
		expect(screen.getByRole("status", { name: "Loading organizations" })).toBeInTheDocument();
		expect(screen.queryByText("No organization found.")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Create organization/ })).toBeInTheDocument();
	});

	it("a loaded context lists the organizations", async () => {
		contextQuery.current = {
			data: {
				activeOrgId: "org-acme",
				organizations: [
					{ id: "org-acme", name: "Acme", slug: "acme", logo: null, role: "owner", plan: "team", status: "active" },
				],
			},
		};
		await open();
		expect(screen.getByRole("option", { name: /Acme/ })).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
