// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Knowledge panel's read-only-for-non-editors surface (agent_context UI follow-up to #832).
// canEditAgentContext gates the write affordances: an editor sees the full editing UI; a non-editor
// (e.g. a viewer under the org-shared flag) gets a read-only panel — no add/edit/delete, readOnly
// instructions, a "Read-only" indicator — so their auto-save never 403s. Mounts against the real
// panel; the server actions are mocked so it renders in jsdom.

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/agent-context", () => ({
	getAgentContext: vi.fn(),
	getProjectKnowledgePreview: vi.fn(),
	upsertAgentContext: vi.fn(),
	canEditAgentContext: vi.fn(),
}));

import { AgentKnowledgePanel } from "@/components/agent/agent-knowledge-panel";
import {
	canEditAgentContext,
	getAgentContext,
	getProjectKnowledgePreview,
} from "@/app/server/actions/agent-context";

const DOC = {
	id: "d1",
	title: "Runbook",
	content: "always drain first",
	updated_at: new Date("2026-07-01T00:00:00Z").toISOString(),
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getAgentContext).mockResolvedValue({
		instructions: "require approval",
		documents: [DOC],
	} as never);
	vi.mocked(getProjectKnowledgePreview).mockResolvedValue("");
});

describe("AgentKnowledgePanel — editor (canEdit true)", () => {
	it("shows the write affordances and editable instructions", async () => {
		vi.mocked(canEditAgentContext).mockResolvedValue(true);
		render(<AgentKnowledgePanel projectId={null} onClose={() => {}} />);

		// Add-knowledge CTA + per-doc edit/delete are present; instructions are editable.
		expect(await screen.findByTestId("knowledge-add")).toBeInTheDocument();
		expect(screen.getByLabelText("Edit Runbook")).toBeInTheDocument();
		expect(screen.getByLabelText("Delete Runbook")).toBeInTheDocument();
		expect(screen.getByTestId("knowledge-instructions")).not.toHaveAttribute("readonly");
		expect(screen.queryByTestId("knowledge-readonly-notice")).not.toBeInTheDocument();
	});
});

describe("AgentKnowledgePanel — non-editor (canEdit false)", () => {
	it("renders read-only: no add/edit/delete, readOnly instructions, a read-only notice", async () => {
		vi.mocked(canEditAgentContext).mockResolvedValue(false);
		render(<AgentKnowledgePanel projectId={null} onClose={() => {}} />);

		// Wait for the async load to settle (the notice only renders once canEdit resolves false).
		expect(await screen.findByTestId("knowledge-readonly-notice")).toBeInTheDocument();

		// Every write affordance is gone…
		expect(screen.queryByTestId("knowledge-add")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Edit Runbook")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Delete Runbook")).not.toBeInTheDocument();
		// …instructions are read-only, and the doc's content is still shown (read).
		expect(screen.getByTestId("knowledge-instructions")).toHaveAttribute("readonly");
		expect(screen.getByText("Runbook")).toBeInTheDocument();
		expect(screen.getByText("Read-only")).toBeInTheDocument();
	});

	it("never calls the save action for a non-editor (no silent 403)", async () => {
		const { upsertAgentContext } = await import("@/app/server/actions/agent-context");
		vi.mocked(canEditAgentContext).mockResolvedValue(false);
		render(<AgentKnowledgePanel projectId={null} onClose={() => {}} />);
		await screen.findByTestId("knowledge-readonly-notice");
		await waitFor(() => expect(getAgentContext).toHaveBeenCalled());
		expect(upsertAgentContext).not.toHaveBeenCalled();
	});
});
