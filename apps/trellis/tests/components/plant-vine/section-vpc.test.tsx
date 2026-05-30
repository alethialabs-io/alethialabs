import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { SectionVpc } from "@/components/plant-vine/section-vpc";
import { renderWithForm } from "./test-utils";

describe("SectionVpc", () => {
	it("renders section title", () => {
		renderWithForm(<SectionVpc />);
		expect(screen.getAllByText("VPC & Networking").length).toBeGreaterThan(0);
	});

	it("shows create new and use existing toggles", () => {
		renderWithForm(<SectionVpc />);
		expect(screen.getAllByText("Create New VPC").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Use Existing VPC").length).toBeGreaterThan(0);
	});

	it("shows CIDR input in create mode", () => {
		renderWithForm(<SectionVpc />);
		expect(screen.getAllByPlaceholderText("10.0.0.0/16").length).toBeGreaterThan(0);
	});

	it("shows CIDR calculator for valid input", () => {
		renderWithForm(<SectionVpc />);
		const inputs = screen.getAllByPlaceholderText("10.0.0.0/16");
		fireEvent.change(inputs[0], { target: { value: "10.0.0.0/24" } });
		expect(screen.getAllByText("256").length).toBeGreaterThan(0);
	});

	it("shows NAT Gateway selector", () => {
		renderWithForm(<SectionVpc />);
		expect(screen.getAllByText("NAT Gateway").length).toBeGreaterThan(0);
	});
});
