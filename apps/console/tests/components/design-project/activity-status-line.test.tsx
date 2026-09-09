// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The one line left over the board from the floating activity list: hidden until something has
// run, the running job when there is one, else the last one, and a click opens the Activity card.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ActivityStatusLine } from "@/components/design-project/canvas/cards/activity-status-line";
import {
	EMPTY_ENVIRONMENT_STATUS,
	type EnvironmentStatus,
} from "@/lib/canvas/component-status";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

function renderWith(status: Partial<EnvironmentStatus>) {
	return render(
		<EnvironmentStatusProvider value={{ ...EMPTY_ENVIRONMENT_STATUS, ...status }}>
			<ActivityStatusLine />
		</EnvironmentStatusProvider>,
	);
}

beforeEach(() => {
	useCanvasStore.getState().reset();
});

describe("ActivityStatusLine", () => {
	it("renders nothing until something has run", () => {
		const { container } = renderWith({});
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the running job first, and opens the activity card on click", async () => {
		renderWith({
			activeJob: { id: "j9", type: "DEPLOY", status: "PROCESSING" },
			recentJobs: [{ id: "j8", type: "PLAN", status: "FAILED", createdAt: "2026-09-07T12:00:00Z" }],
		});
		const line = screen.getByRole("button", { name: /open the activity log/i });
		expect(line).toHaveTextContent(/deploy/i);
		expect(line).toHaveTextContent(/running/i);
		await userEvent.setup().click(line);
		expect(useCanvasStore.getState().card).toEqual({ kind: "activity" });
	});

	it("falls back to the last job with its status and age", () => {
		renderWith({
			recentJobs: [{ id: "j8", type: "PLAN", status: "FAILED", createdAt: "2026-09-07T12:00:00Z" }],
		});
		const line = screen.getByRole("button", { name: /open the activity log/i });
		expect(line).toHaveTextContent(/plan/i);
		expect(line).toHaveTextContent(/failed/i);
	});
});
