// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { SectionNetwork } from "@/components/plant-vine/section-network";
import { renderWithForm } from "./test-utils";

describe("SectionNetwork", () => {
	it("renders section title", () => {
		renderWithForm(<SectionNetwork />);
		expect(screen.getAllByText("Network").length).toBeGreaterThan(0);
	});

	it("shows create new and use existing toggles", () => {
		renderWithForm(<SectionNetwork />);
		expect(screen.getAllByText("Create New VPC").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Use Existing VPC").length).toBeGreaterThan(0);
	});

	it("shows CIDR input in create mode", () => {
		renderWithForm(<SectionNetwork />);
		expect(screen.getAllByPlaceholderText("10.0.0.0/16").length).toBeGreaterThan(0);
	});

	it("shows CIDR calculator for valid input", () => {
		renderWithForm(<SectionNetwork />);
		const inputs = screen.getAllByPlaceholderText("10.0.0.0/16");
		fireEvent.change(inputs[0], { target: { value: "10.0.0.0/24" } });
		expect(screen.getAllByText("256").length).toBeGreaterThan(0);
	});

	it("shows NAT Gateway selector", () => {
		renderWithForm(<SectionNetwork />);
		expect(screen.getAllByText("NAT Gateway").length).toBeGreaterThan(0);
	});
});
