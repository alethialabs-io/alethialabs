// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RocketChat channel sender (lib/alerts/channels/rocketchat.ts). Mocked boundary: stub
// decryptSecret (so we don't need a real crypto key) and global fetch; assert the POSTed
// {text, attachments} payload — severity→colour, field building, optional link, the test
// (verify) synthetic context, and the missing-URL / non-2xx error paths.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/crypto/secrets", () => ({ decryptSecret: vi.fn() }));

import { rocketchatSender } from "@/lib/alerts/channels/rocketchat";
import { decryptSecret } from "@/lib/crypto/secrets";
import type { AlertChannel } from "@/lib/db/schema";
import type { AlertEventContext } from "@/types/database-custom.types";

const WEBHOOK = "https://chat.example.com/hooks/abc/xyz";

/** Builds a channel whose decrypted secret holds the given fields. */
function channelWith(secret: Record<string, string> | null): AlertChannel {
	vi.mocked(decryptSecret).mockReturnValue((secret ?? {}) as never);
	return { secret: secret ? { v: 1 } : null } as never;
}

/** Reads the parsed JSON body of the (single) fetch call. */
function lastBody(): {
	text: string;
	attachments: {
		color: string;
		text: string;
		fields: { title: string; value: string; short: boolean }[];
		title?: string;
		title_link?: string;
	}[];
} {
	const call = vi.mocked(fetch).mock.calls.at(-1);
	if (!call) throw new Error("fetch was not called");
	return JSON.parse((call[1] as RequestInit).body as string);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" } as never),
	);
});

describe("rocketchatSender.send", () => {
	it("POSTs JSON to the decrypted webhook URL with the title bolded", async () => {
		const channel = channelWith({ url: WEBHOOK });
		const ctx: AlertEventContext = {
			title: "Drift detected",
			summary: "A managed resource drifted",
			severity: "warning",
		};

		await rocketchatSender.send(channel, ctx);

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = vi.mocked(fetch).mock.calls[0];
		expect(url).toBe(WEBHOOK);
		expect(init?.method).toBe("POST");
		expect((init?.headers as Record<string, string>)["content-type"]).toBe(
			"application/json",
		);
		const body = lastBody();
		expect(body.text).toBe("*Drift detected*");
		expect(body.attachments[0].text).toBe("A managed resource drifted");
	});

	it("maps each severity onto its attachment colour", async () => {
		const cases: [AlertEventContext["severity"], string][] = [
			["info", "#71717a"],
			["warning", "#a16207"],
			["critical", "#b91c1c"],
		];
		for (const [severity, color] of cases) {
			const channel = channelWith({ url: WEBHOOK });
			await rocketchatSender.send(channel, { title: "t", severity });
			expect(lastBody().attachments[0].color).toBe(color);
		}
	});

	it("defaults to the warning colour when severity is absent", async () => {
		const channel = channelWith({ url: WEBHOOK });
		await rocketchatSender.send(channel, { title: "no sev" });
		expect(lastBody().attachments[0].color).toBe("#a16207");
	});

	it("builds only the present context fields, in order, as short fields", async () => {
		const channel = channelWith({ url: WEBHOOK });
		await rocketchatSender.send(channel, {
			title: "Full context",
			actor_id: "user_1",
			action: "delete",
			resource_type: "project",
			resource_id: "proj_9",
			reason: "policy violation",
			job_id: "job_7",
			project_id: "proj_9",
			connector_slug: "aws-prod",
		});

		expect(lastBody().attachments[0].fields).toEqual([
			{ title: "Actor", value: "user_1", short: true },
			{ title: "Action", value: "delete", short: true },
			{ title: "Resource", value: "project proj_9", short: true },
			{ title: "Reason", value: "policy violation", short: true },
			{ title: "Job", value: "job_7", short: true },
			{ title: "Project", value: "proj_9", short: true },
			{ title: "Connector", value: "aws-prod", short: true },
		]);
	});

	it("omits absent fields and renders resource without an id when none is given", async () => {
		const channel = channelWith({ url: WEBHOOK });
		await rocketchatSender.send(channel, {
			title: "Partial",
			action: "scan",
			resource_type: "cluster",
		});

		expect(lastBody().attachments[0].fields).toEqual([
			{ title: "Action", value: "scan", short: true },
			{ title: "Resource", value: "cluster", short: true },
		]);
	});

	it("adds the console deep link as title/title_link when a link is present", async () => {
		const channel = channelWith({ url: WEBHOOK });
		await rocketchatSender.send(channel, {
			title: "Linked",
			link: "https://console.example.com/x",
		});
		const att = lastBody().attachments[0];
		expect(att.title).toBe("Open in console");
		expect(att.title_link).toBe("https://console.example.com/x");
	});

	it("omits the link keys when no link is present", async () => {
		const channel = channelWith({ url: WEBHOOK });
		await rocketchatSender.send(channel, { title: "Unlinked" });
		const att = lastBody().attachments[0];
		expect(att).not.toHaveProperty("title");
		expect(att).not.toHaveProperty("title_link");
	});

	it("emits an empty summary string when summary is absent", async () => {
		const channel = channelWith({ url: WEBHOOK });
		await rocketchatSender.send(channel, { title: "No summary" });
		expect(lastBody().attachments[0].text).toBe("");
	});

	it("throws (without calling fetch) when the channel has no webhook URL", async () => {
		const channel = channelWith({ notUrl: "x" });
		await expect(
			rocketchatSender.send(channel, { title: "t" }),
		).rejects.toThrow("RocketChat channel has no webhook URL configured");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("throws (without calling fetch) when the channel secret is null", async () => {
		const channel = channelWith(null);
		await expect(
			rocketchatSender.send(channel, { title: "t" }),
		).rejects.toThrow("no webhook URL configured");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("surfaces a non-2xx response as an error carrying status + statusText", async () => {
		vi.mocked(fetch).mockResolvedValue({
			ok: false,
			status: 503,
			statusText: "Service Unavailable",
		} as never);
		const channel = channelWith({ url: WEBHOOK });
		await expect(
			rocketchatSender.send(channel, { title: "t" }),
		).rejects.toThrow("RocketChat responded 503 Service Unavailable");
	});
});

describe("rocketchatSender.verify", () => {
	it("posts the synthetic info test context to the webhook", async () => {
		const channel = channelWith({ url: WEBHOOK });
		await rocketchatSender.verify(channel);

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(vi.mocked(fetch).mock.calls[0][0]).toBe(WEBHOOK);
		const body = lastBody();
		expect(body.text).toBe("*Test alert from Alethia*");
		// info severity → grey
		expect(body.attachments[0].color).toBe("#71717a");
		// synthetic context carries no governance fields
		expect(body.attachments[0].fields).toEqual([]);
	});

	it("propagates a webhook-URL error from verify", async () => {
		const channel = channelWith({});
		await expect(rocketchatSender.verify(channel)).rejects.toThrow(
			"no webhook URL configured",
		);
	});
});
