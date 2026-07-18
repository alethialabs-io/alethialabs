// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Contract lock for the shared ErrorState primitive reused by every list-page fetch-error state
// and the 404 / error boundaries (#707). Guards the rendering shape callers depend on.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ErrorState } from "@/components/errors/error-state";

describe("ErrorState", () => {
	it("renders the title as the heading, plus code, description and actions when given", () => {
		render(
			<ErrorState
				code="500"
				title="Couldn't load clusters"
				description="Something went wrong."
				actions={<button type="button">Retry</button>}
			/>,
		);
		expect(
			screen.getByRole("heading", { name: /Couldn't load clusters/i }),
		).toBeInTheDocument();
		expect(screen.getByText("500")).toBeInTheDocument();
		expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
	});

	it("renders the title alone when optional fields are omitted", () => {
		render(<ErrorState title="Not found" />);
		expect(
			screen.getByRole("heading", { name: /Not found/i }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});
});
