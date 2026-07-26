// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The inspector's `connector` field. Two properties matter beyond "it renders a dropdown":
//
//  1. It must never put a SECRET on a component row. Whatever it writes lands in `provider_config`,
//     which buildConfigSnapshot spreads whole into the Postgres-persisted `config_snapshot` — the
//     same shape as the known plaintext-JSONB gap. The catalog declares no secret provider_config
//     field today, so this is the guard that keeps it true as registry/secrets/dns adopt the field.
//  2. Switching connector must not leave the previous provider's knobs behind, or a stale host rides
//     into the snapshot and the seeded repository credential.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectorSelect } from "@/components/design-project/canvas/inspector/connector-select";
import type { ConnectorProviderMeta } from "@/lib/connectors/registry.generated";

vi.mock("next/navigation", () => ({ useParams: () => ({ org: "acme" }) }));

const meta = (
	slug: string,
	fields: ConnectorProviderMeta["providerConfigFields"],
): ConnectorProviderMeta => ({
	category: "helm_registry",
	slug,
	name: slug,
	description: "",
	organization: "",
	icon_url: "",
	status: "active",
	sort_order: 1,
	modulePath: "",
	credentialFields: [],
	providerConfigFields: fields,
});

// A hypothetical provider whose non-secret bag carries a secret — what this guard exists for.
const PROVIDERS = [
	meta("oci-generic-cr", [
		{ key: "registry_host", label: "Registry host", type: "text", required: true },
		{ key: "sneaky_token", label: "Token", type: "text", secret: true },
	]),
	meta("helm-https", [
		{ key: "repo_url", label: "Repository URL", type: "text", required: true },
	]),
];

vi.mock("@/components/design-project/connectors-context", () => ({
	useConnectedProviders: () => PROVIDERS,
}));

vi.mock("@/lib/connectors/registry.generated", async (importOriginal) => {
	const actual = await importOriginal<
		typeof import("@/lib/connectors/registry.generated")
	>();
	return {
		...actual,
		getConnectorProviderBySlug: (slug: string) =>
			PROVIDERS.find((p) => p.slug === slug),
	};
});

describe("ConnectorSelect", () => {
	it("renders the provider's non-secret knobs and drops any secret one", () => {
		render(
			<ConnectorSelect
				category="helm_registry"
				value="oci-generic-cr"
				providerConfig={{}}
				onChange={vi.fn()}
			/>,
		);

		expect(screen.getByLabelText(/registry host/i)).toBeInTheDocument();
		// A secret must never get a per-project input — it belongs in connector_credentials.
		expect(screen.queryByLabelText(/^token$/i)).not.toBeInTheDocument();
	});

	it("carries over only the new provider's knobs when the connector changes", async () => {
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(
			<ConnectorSelect
				category="helm_registry"
				value="helm-https"
				providerConfig={{ repo_url: "https://charts.acme.io" }}
				onChange={onChange}
			/>,
		);

		await user.click(screen.getByRole("combobox"));
		await user.click(screen.getByRole("option", { name: /oci-generic-cr/i }));

		// `repo_url` means nothing to an OCI provider; leaving it would ride into the snapshot.
		expect(onChange).toHaveBeenCalledWith({
			provider: "oci-generic-cr",
			provider_config: {},
		});
	});
});
