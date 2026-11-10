// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6119 (RUBRIC B4) — a project route whose design read FAILED renders an error, not an endless
// skeleton and not a blank board. The Architecture page passes `sourceProject` as undefined when
// `getProjectAsFormData` throws; the seed effect then (rightly) refuses to paint the blank default
// over a real design, so the board would have waited forever for a design that is not coming.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
const h = vi.hoisted(() => {
	const graph: { throws: boolean } = { throws: false };
	return { graph };
});
vi.mock("@/components/design-project/canvas/graph/form-to-graph", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/components/design-project/canvas/graph/form-to-graph")>();
	return {
		...real,
		formToGraph: (...args: Parameters<typeof real.formToGraph>) => {
			if (h.graph.throws) throw new Error("unreadable design");
			return real.formToGraph(...args);
		},
	};
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/components/design-project/canvas/design-project-canvas", () => ({
	DesignProjectCanvas: () => <div data-testid="canvas" />,
}));
// The board's stand-in while it loads (#6348) reads the page's prefetched queries; this file renders
// no query client and is not about it (board-preview.test.tsx is), so it is a stub here.
vi.mock("@/components/design-project/canvas/board-preview", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/design-project/canvas/board-preview")>()),
	BoardPreview: () => null,
}));
vi.mock("@/components/design-project/repository-context", () => ({
	RepositoryProvider: ({ children }: { children: ReactNode }) => children,
	useRepositoryContext: () => null,
}));

const { buildDefaultFormValues } = await import("@/components/design-project/source-project");
const { DesignProjectWorkbench } = await import(
	"@/components/design-project/design-project-workbench"
);

beforeEach(() => {
	refresh.mockReset();
	h.graph.throws = false;
});

describe("DesignProjectWorkbench — the design read failed", () => {
	it("renders a region error with a retry that re-renders the route, and no board", async () => {
		render(<DesignProjectWorkbench cloudIdentities={[]} projectId="proj-1" environmentId="env-1" />);
		expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load this environment's design/i);
		expect(screen.queryByRole("status", { name: /loading the board/i })).not.toBeInTheDocument();
		expect(screen.queryByTestId("canvas")).not.toBeInTheDocument();

		await userEvent.setup().click(screen.getByRole("button", { name: /try again/i }));
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("is not an error in the create flow, which has no project and no design to read", async () => {
		render(<DesignProjectWorkbench cloudIdentities={[]} />);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(await screen.findByTestId("canvas")).toBeInTheDocument();
	});

	it("a seed that THROWS is a failed design load too — never a skeleton left up forever", async () => {
		h.graph.throws = true;
		render(
			<DesignProjectWorkbench
				cloudIdentities={[]}
				projectId="proj-1"
				environmentId="env-1"
				sourceProject={{ formData: buildDefaultFormValues(), provider: "aws" }}
			/>,
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load this environment's design/i);
		expect(screen.queryByTestId("canvas")).not.toBeInTheDocument();
	});
});
