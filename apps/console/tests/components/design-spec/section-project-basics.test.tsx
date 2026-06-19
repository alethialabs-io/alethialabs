// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { SectionProjectBasics } from "@/components/design-spec/section-project-basics";
import { renderWithForm } from "./test-utils";

vi.mock("@/components/zones/zone-selector", () => ({
	ZoneSelector: ({
		value,
		onChange,
	}: {
		value?: string;
		onChange: (value: string) => void;
	}) => (
		<select data-testid="zone-selector" value={value || ""} onChange={(e) => onChange(e.target.value)}>
			<option value="">Select zone</option>
			<option value="test-id">Test Zone</option>
		</select>
	),
}));

describe("SectionProjectBasics", () => {
	it("renders section title", () => {
		renderWithForm(<SectionProjectBasics />);
		expect(screen.getAllByText("Project Basics").length).toBeGreaterThan(0);
	});

	it("renders project name input", () => {
		renderWithForm(<SectionProjectBasics />);
		expect(screen.getAllByPlaceholderText("my-project").length).toBeGreaterThan(0);
	});

	it("renders zone selector", () => {
		renderWithForm(<SectionProjectBasics />);
		expect(screen.getAllByTestId("zone-selector").length).toBeGreaterThan(0);
	});

	it("enforces lowercase on project name", () => {
		renderWithForm(<SectionProjectBasics />);
		const inputs = screen.getAllByPlaceholderText("my-project") as HTMLInputElement[];
		fireEvent.change(inputs[0], { target: { value: "MyProject" } });
		expect(inputs[0].value).toBe("myproject");
	});

	it("shows character counter when typing", () => {
		renderWithForm(<SectionProjectBasics />);
		const inputs = screen.getAllByPlaceholderText("my-project");
		fireEvent.change(inputs[0], { target: { value: "test" } });
		expect(screen.getAllByText("4/25").length).toBeGreaterThan(0);
	});

	it("marks zone as required with asterisk", () => {
		renderWithForm(<SectionProjectBasics />);
		expect(screen.getAllByText("*").length).toBeGreaterThan(0);
	});
});
