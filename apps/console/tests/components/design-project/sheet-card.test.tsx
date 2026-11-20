// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The chrome every rail card shares. What matters is what it is NOT: a dialog. No overlay, no
// portal, no focus trap — the board behind it stays live. And the three decisions it fixes for
// every card: a heading through SectionHeading, a body that scrolls on its own, a pinned footer.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SheetCard } from "@/components/design-project/canvas/cards/sheet-card";
import { InspectorEmbed } from "@/components/design-project/canvas/inspector-shell/inspector-frame";

describe("SheetCard", () => {
	it("renders eyebrow, heading, description, body and footer with no overlay or dialog role", () => {
		render(
			<SheetCard
				title="Environment settings"
				eyebrow="Environment"
				description="Cluster, VPC and secrets."
				onClose={vi.fn()}
				footer={<button type="button">Save</button>}
			>
				<p>body</p>
			</SheetCard>,
		);
		expect(screen.getByRole("heading", { name: "Environment settings" })).toBeInTheDocument();
		expect(screen.getByText("Environment")).toBeInTheDocument();
		expect(screen.getByText("Cluster, VPC and secrets.")).toBeInTheDocument();
		expect(screen.getByText("body")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(document.querySelector("[data-slot=sheet-overlay]")).toBeNull();
	});

	it("the close control calls onClose", async () => {
		const onClose = vi.fn();
		render(
			<SheetCard title="Card" onClose={onClose}>
				<p>body</p>
			</SheetCard>,
		);
		await userEvent.setup().click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("inside a frame that is already on screen it is a section: no second header, no second close", () => {
		render(
			<InspectorEmbed>
				<SheetCard title="Activity" description="What has run here." onClose={vi.fn()}>
					<p>body</p>
				</SheetCard>
			</InspectorEmbed>,
		);
		expect(screen.getByRole("heading", { level: 3, name: "Activity" })).toBeInTheDocument();
		expect(screen.getByText("What has run here.")).toBeInTheDocument();
		expect(screen.getByText("body")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
	});
});
