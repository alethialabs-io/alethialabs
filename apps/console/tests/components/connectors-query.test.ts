// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's pure rules for clouds a deployment does not offer (#6816): which connectors are
// listed, which take a new connection, and that an account already on a card outranks "this
// instance cannot connect one".

import { describe, expect, it } from "vitest";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import {
	acceptsNewConnections,
	buildConnectorsView,
	connectorState,
	listedConnectors,
	notOfferedSentence,
} from "@/components/connectors/connectors-query";

/** A catalog row with nothing connected; `over` makes it the connector a test needs. */
function connector(over: Partial<ConnectorWithConnection>): ConnectorWithConnection {
	return {
		id: `c-${over.slug ?? "datadog"}`,
		slug: "datadog",
		name: "Datadog",
		description: "Datadog.",
		category: "observability",
		auth_method: "api_key",
		organization: "Datadog, Inc.",
		icon_url: "/icons/datadog.png",
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

const aws = connector({ slug: "aws", name: "AWS", category: "cloud", auth_method: "iam_role", group: "clouds" });
const far = connector({ slug: "farcloud", name: "Far Cloud", category: "cloud", auth_method: "ram_role", group: "clouds" });
const tokenCloud = connector({ slug: "tokencloud", name: "Token Cloud", category: "cloud", auth_method: "api_key", group: "clouds" });
const awsKeyless = connector({ slug: "ecr-xacct", category: "registry", auth_method: "iam_role", group: "registries" });
const farKeyless = connector({ slug: "far-secrets-xacct", category: "secrets", auth_method: "ram_role", group: "secrets" });
const tokenRegistry = connector({ slug: "tokencloud-registry", category: "registry", auth_method: "api_key", group: "registries" });
const github = connector({ slug: "github", category: "git", auth_method: "oauth", group: "source" });

/** The slugs of a list, in order. */
const slugs = (rows: ConnectorWithConnection[]) => rows.map((r) => r.slug);

describe("acceptsNewConnections", () => {
	it("is the offered set for a cloud, and always true for anything else", () => {
		expect(acceptsNewConnections(aws, ["aws"])).toBe(true);
		expect(acceptsNewConnections(far, ["aws"])).toBe(false);
		expect(acceptsNewConnections(far, [])).toBe(false);
		expect(acceptsNewConnections(farKeyless, [])).toBe(true);
		expect(acceptsNewConnections(github, [])).toBe(true);
	});

	it("names the cloud in the sentence it gives", () => {
		expect(notOfferedSentence("Far Cloud")).toContain("Far Cloud is not available for new projects");
	});
});

describe("listedConnectors", () => {
	it("leaves out a connector that signs in with the identity of a cloud that is not offered", () => {
		expect(slugs(listedConnectors([aws, awsKeyless, farKeyless, github], ["aws"]))).toEqual([
			"aws",
			"ecr-xacct",
			"github",
		]);
	});

	it("leaves it out even when that cloud's card is on the board for an existing account", () => {
		const rows = [aws, far, awsKeyless, farKeyless];
		expect(slugs(listedConnectors(rows, ["aws"]))).toEqual(["aws", "farcloud", "ecr-xacct"]);
	});

	it("lists it once the cloud is offered", () => {
		const rows = [aws, far, awsKeyless, farKeyless];
		expect(slugs(listedConnectors(rows, ["aws", "farcloud"]))).toEqual(slugs(rows));
	});

	it("never drops a connector that takes its own credential, whoever makes it", () => {
		// A registry that needs only a token is usable from any cluster, so a token cloud that is
		// not offered takes nothing with it.
		const rows = [aws, tokenCloud, tokenRegistry, github];
		expect(slugs(listedConnectors(rows, ["aws"]))).toEqual(slugs(rows));
	});

	it("never drops a cloud card: the read decides those", () => {
		expect(slugs(listedConnectors([far], []))).toEqual(["farcloud"]);
	});

	it("gives counts that leave the dropped row out, with facets over the listed universe", () => {
		const listed = listedConnectors([aws, awsKeyless, farKeyless, github], ["aws"]);
		const view = buildConnectorsView(listed, { groups: ["clouds"] }, {});
		expect(view.total).toBe(3);
		expect(slugs(view.rows)).toEqual(["aws"]);
		expect(view.facets.groups.map((g) => [g.value, g.count])).toEqual([
			["clouds", 1],
			["source", 1],
			["registries", 1],
		]);
	});
});

describe("connectorState — an account already on the card", () => {
	const failedAccount = { identityId: "id-1", name: "Old", status: "failed" as const };

	it("is unavailable when the instance cannot connect the cloud and there is no account", () => {
		expect(connectorState(far, false).health).toBe("unavailable");
	});

	it("reads the account's own state when there is one, so it can still be managed", () => {
		const state = connectorState({ ...far, cloud_health: "failed", accounts: [failedAccount] }, false);
		expect(state).toEqual({ health: "attention", label: "Verification failed", destructive: true });
	});

	it("is unchanged for a connected cloud", () => {
		const state = connectorState(
			{ ...far, connected: true, accounts: [{ ...failedAccount, status: "connected" }] },
			false,
		);
		expect(state.health).toBe("connected");
	});
});
