// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Connector setup URLs per instance edition (EDN-H7, #6904). The hosted asset bucket is chosen only
// when the edition contract says the instance IS the hosted service; a self-hosted instance (and
// a surface with no edition) is pointed at its own origin, and the issuer never falls back to the
// hosted service.

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeEnv = new Map<string, string>();
vi.mock("next-runtime-env", () => ({ env: (key: string) => runtimeEnv.get(key) }));

import {
	alethiaIssuerUrl,
	connectorAssetOrigin,
	connectorAssetUrl,
	useConnectorAssets,
} from "@/components/connectors/connector-assets";
import type { ShellEdition } from "@/components/shell/shell-edition";
import { ShellEditionProvider } from "@/components/shell/shell-edition-provider";

const HOSTED: ShellEdition = { deployment: "hosted", edition: "enterprise", offering: "hosted" };
const SELF_HOSTED: ShellEdition = { deployment: "self-managed", edition: "community", offering: "self-hosted" };
const ENTERPRISE: ShellEdition = { deployment: "self-managed", edition: "enterprise", offering: "enterprise" };

const BUCKET = "https://alethia-connector-assets.s3.eu-west-1.amazonaws.com";

beforeEach(() => {
	runtimeEnv.clear();
});

describe("connectorAssetOrigin", () => {
	it("uses the hosted bucket on the hosted service when no origin is configured", () => {
		runtimeEnv.set("NEXT_PUBLIC_APP_URL", "https://console.example.com");
		expect(connectorAssetOrigin(HOSTED)).toBe(BUCKET);
	});

	it.each([
		["self-hosted", SELF_HOSTED],
		["enterprise self-managed", ENTERPRISE],
		["unknown (outside the shell)", null],
	])("points a %s instance at its own origin, never the hosted bucket", (_label, edition) => {
		runtimeEnv.set("NEXT_PUBLIC_APP_URL", "https://alethia.example.com/");
		expect(connectorAssetOrigin(edition)).toBe("https://alethia.example.com");
		expect(connectorAssetUrl("alethia-gcp-setup.sh", edition)).toBe(
			"https://alethia.example.com/alethia-gcp-setup.sh",
		);
	});

	it("never yields the hosted bucket for a self-hosted instance with no origin set", () => {
		expect(connectorAssetOrigin(SELF_HOSTED)).toBe("");
		expect(connectorAssetOrigin(null)).toBe("");
	});

	it("prefers the operator's configured asset origin on every edition", () => {
		runtimeEnv.set("NEXT_PUBLIC_APP_URL", "https://alethia.example.com");
		runtimeEnv.set("NEXT_PUBLIC_CONNECTOR_ASSETS_ORIGIN", " https://assets.example.com// ");
		for (const edition of [HOSTED, SELF_HOSTED, null]) {
			expect(connectorAssetOrigin(edition)).toBe("https://assets.example.com");
		}
	});
});

describe("alethiaIssuerUrl", () => {
	it("is the instance's own origin under /api/oidc", () => {
		runtimeEnv.set("NEXT_PUBLIC_APP_URL", "https://alethia.example.com/");
		expect(alethiaIssuerUrl()).toBe("https://alethia.example.com/api/oidc");
	});

	it("has no hosted default when the origin is unset", () => {
		expect(alethiaIssuerUrl()).toBe("/api/oidc");
		expect(alethiaIssuerUrl()).not.toMatch(/alethialabs/);
	});
});

describe("useConnectorAssets", () => {
	/** Renders the hook under a shell edition provider for `edition`. */
	function renderUnder(edition: ShellEdition) {
		const wrapper = ({ children }: { children: ReactNode }) => (
			<ShellEditionProvider edition={edition}>{children}</ShellEditionProvider>
		);
		return renderHook(() => useConnectorAssets(), { wrapper }).result.current;
	}

	it("reads the edition the shell was given", () => {
		runtimeEnv.set("NEXT_PUBLIC_APP_URL", "https://alethia.example.com");
		expect(renderUnder(HOSTED).assetUrl("alethia-aws-setup.sh")).toBe(`${BUCKET}/alethia-aws-setup.sh`);
		const selfHosted = renderUnder(SELF_HOSTED);
		expect(selfHosted.assetUrl("alethia-aws-setup.sh")).toBe(
			"https://alethia.example.com/alethia-aws-setup.sh",
		);
		expect(selfHosted.issuerUrl).toBe("https://alethia.example.com/api/oidc");
	});

	it("does not use the hosted bucket outside the shell", () => {
		runtimeEnv.set("NEXT_PUBLIC_APP_URL", "https://alethia.example.com");
		const { result } = renderHook(() => useConnectorAssets());
		expect(result.current.assetUrl("alethia-azure-setup.sh")).toBe(
			"https://alethia.example.com/alethia-azure-setup.sh",
		);
	});
});
