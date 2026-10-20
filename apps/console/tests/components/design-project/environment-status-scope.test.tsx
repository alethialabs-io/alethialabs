// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6119 — the board's ONE environment-status read, and what the board says when it fails.
//
// The read used to live in the project shell, a layout, which never receives `?environment_id=`;
// so it could not be prefetched under the key it asked for, and the board painted every node in its
// design state first. It now lives with the canvas and is published to every node. A failed read
// with nothing to show is SAID (RUBRIC B4: error is not "everything is in its design state"), and a
// refusal is said as a refusal, with no retry that cannot help.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_ENVIRONMENT_STATUS, type EnvironmentStatus } from "@/lib/canvas/component-status";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, FakeHandler>,
	calls: [] as FakeCall[],
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});

const { EnvironmentStatusScope } = await import(
	"@/components/design-project/canvas/environment-status-scope"
);
const { EnvironmentStatusNotice } = await import(
	"@/components/design-project/canvas/environment-status-notice"
);

const LIVE: EnvironmentStatus = {
	...EMPTY_ENVIRONMENT_STATUS,
	environment: { id: "env-1", name: "production", stage: "production", status: "ACTIVE" },
};

/** What a node reads: the environment's name, or "none". */
function NodeProbe() {
	const status = useEnvironmentStatus();
	return <span data-testid="node">{status.environment?.name ?? "none"}</span>;
}

let qc: QueryClient;

/** Renders the scope over a node probe and the notice. `null` is the create flow (no project). */
function renderScope(projectId: string | null = "proj-1", children: ReactNode = null) {
	return render(
		<QueryClientProvider client={qc}>
			<EnvironmentStatusScope projectId={projectId ?? undefined} environmentId="env-1">
				<NodeProbe />
				<EnvironmentStatusNotice />
				{children}
			</EnvironmentStatusScope>
		</QueryClientProvider>,
	);
}

/** An oRPC-shaped defined refusal, as the browser receives one (`lib/rpc/base.ts`). */
function refusal(code: string): Error {
	return Object.assign(new Error(code), { defined: true, code });
}

beforeEach(() => {
	// The console's own default staleTime (lib/query/client.ts): a hydrated entry is trusted on mount.
	qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
	h.calls.length = 0;
});

describe("EnvironmentStatusScope", () => {
	it("publishes the status it read to every node", async () => {
		h.handlers["canvas.environmentStatus"] = async () => LIVE;
		renderScope();
		expect(await screen.findByText("production")).toBeInTheDocument();
		expect(h.calls).toEqual([
			{ path: "canvas.environmentStatus", input: { projectId: "proj-1", environmentId: "env-1" } },
		]);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("renders from a PREFETCHED status with no read of its own (the page hydrated the key)", () => {
		qc.setQueryData(
			[["canvas", "environmentStatus"], { input: { projectId: "proj-1", environmentId: "env-1" }, type: "query" }],
			LIVE,
		);
		h.handlers["canvas.environmentStatus"] = async () => LIVE;
		renderScope();
		expect(screen.getByTestId("node")).toHaveTextContent("production");
		expect(h.calls).toEqual([]);
	});

	it("reads nothing in the create flow, and every node gets the empty status", async () => {
		renderScope(null);
		await new Promise((r) => setTimeout(r, 30));
		expect(h.calls).toEqual([]);
		expect(screen.getByTestId("node")).toHaveTextContent("none");
	});
});

describe("EnvironmentStatusNotice", () => {
	it("says the read failed and offers a retry that reads again", async () => {
		let fail = true;
		h.handlers["canvas.environmentStatus"] = async () => {
			if (fail) throw new Error("boom");
			return LIVE;
		};
		renderScope();
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/couldn't load this environment's live status/i);
		expect(alert).not.toHaveTextContent("boom");

		fail = false;
		await userEvent.setup().click(screen.getByRole("button", { name: /try again/i }));
		expect(await screen.findByText("production")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("says a refusal is a refusal, with no retry", async () => {
		h.handlers["canvas.environmentStatus"] = async () => {
			throw refusal("FORBIDDEN");
		};
		renderScope();
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/don't have permission/i);
		expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
	});

	it("says nothing while the read is pending", () => {
		h.handlers["canvas.environmentStatus"] = () => new Promise(() => {});
		renderScope();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
