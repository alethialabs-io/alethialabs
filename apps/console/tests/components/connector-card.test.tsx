// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Component test for ConnectorCard: a connected connector renders its logo in
// full color (no grayscale filter) and offers "Manage"; a not-connected one is
// grayscale and offers "Connect".

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { ConnectorCard } from "@/components/connectors/connector-card";

/** Builds a non-git (observability) connector fixture so the logo routes through ConnectorIcon. */
function connector(
	over: Partial<ConnectorWithConnection> = {},
): ConnectorWithConnection {
	return {
		id: "c-1",
		slug: "datadog",
		name: "Datadog",
		description: "Observability platform.",
		category: "observability",
		auth_method: "api_key",
		organization: "Datadog, Inc.",
		icon_url: "/icons/datadog/datadog-32x32.png",
		docs_url: null,
		support_url: null,
		privacy_url: null,
		status: "active",
		sort_order: 0,
		created_at: null,
		updated_at: null,
		connected: false,
		connection_details: null,
		group: "observability",
		...over,
	};
}

describe("ConnectorCard", () => {
	it("renders a connected logo in color and offers Manage", () => {
		render(
			<ConnectorCard
				integration={connector({ connected: true })}
				canManage
				onConnect={() => {}}
				onManage={() => {}}
			/>,
		);
		const logo = screen.getByAltText("Datadog");
		expect(logo.className).not.toContain("grayscale");
		expect(screen.getByRole("button", { name: /manage/i })).toBeInTheDocument();
	});

	it("renders a not-connected logo in grayscale and offers Connect", () => {
		render(
			<ConnectorCard
				integration={connector({ connected: false })}
				canManage
				onConnect={() => {}}
				onManage={() => {}}
			/>,
		);
		const logo = screen.getByAltText("Datadog");
		expect(logo.className).toContain("grayscale");
		expect(screen.getByRole("button", { name: /connect/i })).toBeInTheDocument();
	});

	it("shows Verification failed + a Re-verify action that calls onReverify", async () => {
		const user = userEvent.setup();
		const onReverify = vi.fn();
		render(
			<ConnectorCard
				integration={connector({
					category: "cloud",
					slug: "aws",
					name: "AWS",
					connected: false,
					cloud_health: "failed",
					last_error: "AssumeRole denied — check the role trust policy.",
					reverify_identity_id: "id-1",
				})}
				canManage
				onConnect={() => {}}
				onManage={() => {}}
				onReverify={onReverify}
			/>,
		);
		expect(screen.getByText(/verification failed/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /re-verify/i }));
		expect(onReverify).toHaveBeenCalledTimes(1);
	});

	it("gates an unconfigured git provider — 'Not enabled on this instance', no Connect", () => {
		render(
			<ConnectorCard
				integration={connector({
					category: "git",
					slug: "github",
					name: "GitHub",
					connected: false,
				})}
				canManage
				platformConfigured={false}
				onConnect={() => {}}
				onManage={() => {}}
			/>,
		);
		expect(screen.getByText(/not enabled on this instance/i)).toBeInTheDocument();
		expect(screen.getByText(/unavailable/i)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /connect/i }),
		).not.toBeInTheDocument();
	});

	it("offers Connect for a configured git provider", () => {
		render(
			<ConnectorCard
				integration={connector({
					category: "git",
					slug: "github",
					name: "GitHub",
					connected: false,
				})}
				canManage
				platformConfigured
				onConnect={() => {}}
				onManage={() => {}}
			/>,
		);
		expect(screen.getByRole("button", { name: /connect/i })).toBeInTheDocument();
		expect(
			screen.queryByText(/not enabled on this instance/i),
		).not.toBeInTheDocument();
	});

	it("shows a Verifying… state with no action while a test is in flight", () => {
		render(
			<ConnectorCard
				integration={connector({
					category: "cloud",
					slug: "aws",
					name: "AWS",
					connected: false,
					cloud_health: "testing",
				})}
				canManage
				onConnect={() => {}}
				onManage={() => {}}
				onReverify={() => {}}
			/>,
		);
		expect(screen.getByText(/verifying/i)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /connect|re-verify/i }),
		).not.toBeInTheDocument();
	});
});
