// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// An unpriced environment shows NOTHING in the toolbar — no fabricated $0, and no dashed "Not
// priced" pill on the row meant to ease a first visit in. The number appears once a plan priced it.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CostChip } from "@/components/design-project/canvas/cost-chip";
import {
	EMPTY_ENVIRONMENT_STATUS,
	type EnvironmentStatus,
} from "@/lib/canvas/component-status";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";

function renderWith(status: Partial<EnvironmentStatus>) {
	return render(
		<EnvironmentStatusProvider value={{ ...EMPTY_ENVIRONMENT_STATUS, ...status }}>
			<CostChip />
		</EnvironmentStatusProvider>,
	);
}

describe("CostChip", () => {
	it("renders nothing when the environment has never been priced", () => {
		const { container } = renderWith({ monthlyCost: null });
		expect(container).toBeEmptyDOMElement();
		expect(screen.queryByText(/not priced/i)).not.toBeInTheDocument();
	});

	it("renders the monthly rate once a plan priced it", () => {
		renderWith({ monthlyCost: 12.5 });
		expect(screen.getByText(/12\.50/)).toBeInTheDocument();
	});
});
