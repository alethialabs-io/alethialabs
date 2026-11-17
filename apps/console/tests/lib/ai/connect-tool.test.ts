// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// connect_cloud surfaces a one-click "connect this cloud" action and reports whether the cloud is already
// connected (so elench never tells a user to connect something they already have). These pin that contract.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { connectTools } from "@/lib/ai/tools/connect";
import { withHiddenClouds } from "@/lib/cloud-providers/availability";

vi.mock("server-only", () => ({}));
vi.mock("@/app/server/actions/aws/identities", () => ({
	getVerifiedCloudIdentities: vi.fn(),
}));

const mockGet = vi.mocked(getVerifiedCloudIdentities);

type ConnectResult = { provider: string; alreadyConnected: boolean; connectedAccounts: string[] };

async function run(provider: string): Promise<ConnectResult> {
	const t = connectTools().connect_cloud;
	// @ts-expect-error — invoke the tool's execute directly with a minimal options arg.
	return t.execute({ provider }, {});
}

beforeEach(() => mockGet.mockReset());

describe("connect_cloud", () => {
	it("reports alreadyConnected + the accounts when the provider is connected", async () => {
		mockGet.mockResolvedValue([
			{ id: "1", provider: "aws", name: "prod", displayId: "1234" },
			{ id: "2", provider: "gcp", name: "g", displayId: "proj" },
		]);
		const r = await run("aws");
		expect(r.provider).toBe("aws");
		expect(r.alreadyConnected).toBe(true);
		expect(r.connectedAccounts).toEqual(["1234"]);
	});

	it("reports not-connected when the provider has no identity", async () => {
		mockGet.mockResolvedValue([{ id: "2", provider: "gcp", name: "g", displayId: "proj" }]);
		const r = await run("azure");
		expect(r.alreadyConnected).toBe(false);
		expect(r.connectedAccounts).toEqual([]);
	});

	it("returns not-connected when there are no identities at all", async () => {
		mockGet.mockResolvedValue([]);
		const r = await run("hetzner");
		expect(r.alreadyConnected).toBe(false);
		expect(r.connectedAccounts).toEqual([]);
	});
});

describe("connect_cloud — which clouds it accepts", () => {
	/** The tool's input schema as the zod type it is at run time (the AI SDK's type erases it). */
	const schema = () => connectTools().connect_cloud.inputSchema as z.ZodType;

	it.each(["aws", "gcp", "azure", "hetzner"])("accepts %s", (provider) => {
		expect(schema().safeParse({ provider }).success).toBe(true);
	});

	it.each(["alibaba", "digitalocean", "civo", "kubernetes"])("refuses %s", (provider) => {
		expect(schema().safeParse({ provider }).success).toBe(false);
	});

	it("accepts a provisioning cloud once the operator setting names it", async () => {
		const parsed = await withHiddenClouds(["alibaba"], () => schema().safeParse({ provider: "alibaba" }));
		expect(parsed.success).toBe(true);
	});

	it("does not name a cloud that is not offered in its description", () => {
		expect(connectTools().connect_cloud.description).not.toMatch(/alibaba|digitalocean|civo/i);
	});
});
