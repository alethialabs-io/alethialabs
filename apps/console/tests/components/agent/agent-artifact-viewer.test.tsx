// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The artifact viewer's action buttons while their action runs (#7871): each is a `Button pending`
// that names what it is doing — "Adding to chat…", "Opening new chat…" — instead of swapping its
// icon for a spinning lucide Loader2 under an unchanged label.

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/agent/artifact-share-popover", () => ({
	ArtifactSharePopover: () => null,
}));

import { AgentArtifactViewer } from "@/components/agent/agent-artifact-viewer";
import type { AgentArtifact } from "@/lib/db/schema";

const ARTIFACT: AgentArtifact = {
	id: "a1",
	user_id: "u1",
	org_id: "o1",
	name: "Cost board",
	kind: "dashboard",
	spec: { widgets: [] },
	created_at: new Date("2026-11-01T00:00:00Z"),
	updated_at: new Date("2026-11-01T00:00:00Z"),
};

/** A promise the test settles by hand, standing in for an action still in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Renders the viewer with the given action handlers. */
function renderViewer(
	overrides: Partial<{
		onAddToChat: () => Promise<void>;
		onOpenInNewChat: () => Promise<void>;
		deleting: boolean;
	}> = {},
) {
	return render(
		<AgentArtifactViewer
			artifact={ARTIFACT}
			hasActiveChat
			onBack={() => {}}
			onAddToChat={overrides.onAddToChat ?? (() => Promise.resolve())}
			onOpenInNewChat={overrides.onOpenInNewChat ?? (() => Promise.resolve())}
			onDelete={() => {}}
			deleting={overrides.deleting ?? false}
		/>,
	);
}

describe("AgentArtifactViewer — pending actions", () => {
	it("names the add while it runs, then returns to rest", async () => {
		const add = deferred();
		const user = userEvent.setup();
		renderViewer({ onAddToChat: () => add.promise });

		await user.click(screen.getByRole("button", { name: "Add to this chat" }));
		const pending = screen.getByRole("button", { name: "Adding to chat…" });
		expect(pending).toHaveAttribute("aria-busy", "true");
		expect(pending).toBeDisabled();
		expect(pending.querySelector('[data-slot="button-pending-mark"]')).not.toBeNull();
		// Every other side effect is gated while one runs.
		expect(screen.getByRole("button", { name: "Open in new chat" })).toBeDisabled();

		await act(async () => {
			add.resolve();
			await add.promise;
		});
		expect(screen.getByRole("button", { name: "Add to this chat" })).not.toHaveAttribute("aria-busy");
	});

	it("names the new-chat open while it runs", async () => {
		const open = deferred();
		const user = userEvent.setup();
		renderViewer({ onOpenInNewChat: () => open.promise });

		await user.click(screen.getByRole("button", { name: "Open in new chat" }));
		expect(screen.getByRole("button", { name: "Opening new chat…" })).toHaveAttribute("aria-busy", "true");

		await act(async () => {
			open.resolve();
			await open.promise;
		});
	});

	it("marks the delete button pending while the delete is outstanding", () => {
		const { container } = renderViewer({ deleting: true });
		const del = screen.getByRole("button", { name: "Delete artifact Cost board" });
		expect(del).toHaveAttribute("aria-busy", "true");
		expect(del.querySelector('[data-slot="button-pending-mark"]')).not.toBeNull();
		expect(container.querySelector(".animate-spin")).toBeNull();
	});
});
