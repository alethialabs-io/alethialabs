// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { SectionNosql } from "@/components/design-project/section-nosql";
import { renderWithForm } from "./test-utils";

describe("SectionNosql", () => {
	it("renders empty state", () => {
		renderWithForm(<SectionNosql />);
		expect(screen.getAllByText("No NoSQL tables configured.").length).toBeGreaterThan(0);
	});

	it("adds table on button click", () => {
		renderWithForm(<SectionNosql />);
		const buttons = screen.getAllByText("Add Table");
		fireEvent.click(buttons[0]);
		expect(screen.getAllByPlaceholderText("id").length).toBeGreaterThan(0);
	});

	it("shows hash key input after adding", () => {
		renderWithForm(<SectionNosql />);
		const buttons = screen.getAllByText("Add Table");
		fireEvent.click(buttons[0]);
		expect(screen.getAllByPlaceholderText("id").length).toBeGreaterThan(0);
	});

	it("has advanced options text", () => {
		renderWithForm(<SectionNosql />);
		const buttons = screen.getAllByText("Add Table");
		fireEvent.click(buttons[0]);
		expect(screen.getAllByText("Advanced options").length).toBeGreaterThan(0);
	});
});
