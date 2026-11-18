// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The support assistant's system prompt names the clouds this deployment offers, read when the
// prompt is built (#6811). The offered set is fixed here by decision (2026-11-17): AWS, GCP, Azure
// and Hetzner; Alibaba, DigitalOcean and Civo are not offered.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { supportSystemPrompt } from "@/lib/ai/support/prompt";
import { withHiddenClouds } from "@/lib/cloud-providers/availability";

describe("supportSystemPrompt", () => {
	it("names the four offered clouds as the accounts a user can have", () => {
		expect(supportSystemPrompt()).toContain("accounts (AWS, GCP, Azure and Hetzner) plus pluggable");
	});

	it("names no cloud that is not offered", () => {
		expect(supportSystemPrompt()).not.toMatch(/alibaba|digitalocean|civo/i);
	});

	it("lists the federation mechanism of each offered cloud that has one", () => {
		expect(supportSystemPrompt()).toContain(
			"own OIDC issuer (AWS AssumeRoleWithWebIdentity, GCP WIF, Azure federated identity). To connect",
		);
	});

	it("names a hidden cloud once the operator setting names it", async () => {
		const prompt = await withHiddenClouds(["alibaba"], () => supportSystemPrompt());
		expect(prompt).toContain("accounts (AWS, GCP, Azure, Hetzner and Alibaba) plus pluggable");
		expect(prompt).toContain("Azure federated identity, Alibaba AssumeRoleWithOIDC). To connect");
	});

	it("does not list a connect-only cloud as an account a project can be built on", async () => {
		const prompt = await withHiddenClouds(["civo"], () => supportSystemPrompt());
		expect(prompt).toContain("accounts (AWS, GCP, Azure and Hetzner) plus pluggable");
	});
});
