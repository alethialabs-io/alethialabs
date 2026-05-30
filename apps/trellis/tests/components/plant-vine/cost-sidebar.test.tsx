import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { CostSidebar } from "@/components/plant-vine/cost-sidebar";
import { renderWithForm } from "./test-utils";

describe("CostSidebar", () => {
	it("renders estimated cost title", () => {
		renderWithForm(<CostSidebar />);
		expect(screen.getAllByText("Estimated Cost").length).toBeGreaterThan(0);
	});

	it("shows EKS control plane cost", () => {
		renderWithForm(<CostSidebar />);
		expect(screen.getAllByText("EKS Control Plane").length).toBeGreaterThan(0);
	});

	it("shows EKS nodes cost", () => {
		renderWithForm(<CostSidebar />);
		expect(screen.getAllByText("EKS Nodes").length).toBeGreaterThan(0);
	});

	it("shows NAT gateway cost", () => {
		renderWithForm(<CostSidebar />);
		expect(screen.getAllByText("NAT Gateway").length).toBeGreaterThan(0);
	});

	it("shows total", () => {
		renderWithForm(<CostSidebar />);
		expect(screen.getAllByText("Total").length).toBeGreaterThan(0);
	});

	it("shows price source hint when no region selected", () => {
		renderWithForm(<CostSidebar />);
		expect(screen.getAllByText("Select a region for real prices").length).toBeGreaterThan(0);
	});
});
