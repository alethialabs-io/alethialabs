// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ConnectorIcon under #3907's rulings (docs/legal/DESIGN_SYSTEM_AUDIT.md, "Rulings, 2026-09-30"):
//
//   * a third-party connector mark is recognised by where it is served, `/icons/…`, and a cloud
//     mark is not — the cloud marks' own question is still open, so they must not be swept in;
//   * the Vault mark is used only as a link to the Vault project, so it renders as that link where
//     the icon is not inside another control, and as the monogram where it is;
//   * the GitHub mark is GitHub's own black file, with GitHub's own white file for the dark theme —
//     never one file recoloured in CSS.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectorIcon, isThirdPartyMark } from "@/components/connectors/connector-icon";

const VAULT = "/icons/vault/vault-32x32.png";
const GITHUB_BLACK = "/icons/github/GitHub_Invertocat_Black.png";
const GITHUB_WHITE = "/icons/github/GitHub_Invertocat_White.png";

describe("isThirdPartyMark", () => {
	it("is true for a connector mark and false for a cloud mark or no mark", () => {
		expect(isThirdPartyMark("/icons/datadog/datadog-32x32.png")).toBe(true);
		expect(isThirdPartyMark(GITHUB_BLACK)).toBe(true);
		expect(isThirdPartyMark("/aws/favicon_64x64.png")).toBe(false);
		expect(isThirdPartyMark(null)).toBe(false);
		expect(isThirdPartyMark("")).toBe(false);
	});
});

describe("ConnectorIcon — the Vault mark", () => {
	it("renders as a link to the Vault project, unmodified, where it can link", () => {
		render(<ConnectorIcon src={VAULT} name="HashiCorp Vault" mono={false} canLink />);
		const link = screen.getByRole("link", { name: "HashiCorp Vault" });
		expect(link).toHaveAttribute("href", "https://developer.hashicorp.com/vault");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
		expect(screen.getByAltText("HashiCorp Vault").className).not.toContain("grayscale");
	});

	it("renders the monogram, not the mark, inside another control", () => {
		render(<ConnectorIcon src={VAULT} name="HashiCorp Vault" mono={false} />);
		expect(screen.queryByAltText("HashiCorp Vault")).toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByText("H")).toBeInTheDocument();
	});
});

describe("ConnectorIcon — the GitHub mark", () => {
	it("renders GitHub's black file for light and GitHub's white file for dark, neither filtered", () => {
		render(<ConnectorIcon src={GITHUB_BLACK} name="GitHub Container Registry" mono={false} />);
		const [light, dark] = screen.getAllByAltText("GitHub Container Registry");
		expect(light.getAttribute("src")).toContain(encodeURIComponent(GITHUB_BLACK));
		expect(light.className).toContain("dark:hidden");
		expect(dark.getAttribute("src")).toContain(encodeURIComponent(GITHUB_WHITE));
		expect(dark.className).toContain("dark:block");
		for (const img of [light, dark]) expect(img.className).not.toContain("grayscale");
	});
});

describe("ConnectorIcon — any other mark", () => {
	it("is not a link even when it could be", () => {
		render(<ConnectorIcon src="/icons/grafana/grafana-32x32.png" name="Grafana" mono={false} canLink />);
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByAltText("Grafana")).toBeInTheDocument();
	});
});
