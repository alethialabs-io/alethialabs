// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Flag-gating tests for the canvas ⌘K palette's BYO IaC entry: present only when onAttachIac is
// wired (feature on + project + no governing source), absent otherwise; and when disableComponentAdd
// is set (an IaC source governs the env) the Core/Periphery service groups are hidden.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CanvasCommandPalette } from "@/components/design-project/canvas/canvas-command-palette";

const baseProps = {
	open: true,
	onOpenChange: vi.fn(),
	onSave: vi.fn(),
	onFitView: vi.fn(),
	onAskAi: vi.fn(),
};

describe("CanvasCommandPalette — BYO IaC gating", () => {
	it("hides the 'Bring your own IaC' entry when the feature is off (no onAttachIac)", () => {
		render(<CanvasCommandPalette {...baseProps} />);
		expect(screen.queryByText("Bring your own IaC")).not.toBeInTheDocument();
	});

	it("shows the 'Bring your own IaC' entry and runs it when wired", async () => {
		const user = userEvent.setup();
		const onAttachIac = vi.fn();
		render(<CanvasCommandPalette {...baseProps} onAttachIac={onAttachIac} />);
		const item = screen.getByText("Bring your own IaC");
		expect(item).toBeInTheDocument();
		await user.click(item);
		expect(onAttachIac).toHaveBeenCalledTimes(1);
	});

	it("hides the component service groups when an IaC source governs the env", () => {
		render(
			<CanvasCommandPalette
				{...baseProps}
				onAttachIac={vi.fn()}
				disableComponentAdd
			/>,
		);
		expect(screen.queryByText("Core services")).not.toBeInTheDocument();
		expect(screen.queryByText("Periphery")).not.toBeInTheDocument();
		// The Sources group still shows.
		expect(screen.getByText("Bring your own IaC")).toBeInTheDocument();
	});
});
