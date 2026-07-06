// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Slack incoming-webhook sender (lib/alerts/channels/slack.ts). Mocked boundary: stub
// decryptSecret (returns the channel webhook URL) and global fetch; assert the Block Kit
// payload formatting (severity emoji, summary/context/actions blocks), URL resolution,
// and send()/verify() success + failure throws.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/crypto/secrets", () => ({ decryptSecret: vi.fn() }));

import { slackSender } from "@/lib/alerts/channels/slack";
import { TEST_CONTEXT } from "@/lib/alerts/channels/types";
import { decryptSecret } from "@/lib/crypto/secrets";
import type { AlertChannel } from "@/lib/db/schema";
import type { AlertEventContext } from "@/types/jsonb.types";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/xyz";

/** Minimal channel fixture; the encrypted secret is irrelevant (decryptSecret is mocked). */
const channel = (secret: unknown = { sealed: true }): AlertChannel =>
	({ id: "ch-1", secret } as never);

/** Reads the JSON body POSTed to Slack from the fetch mock's last call. */
function lastBody(): { text: string; blocks: Array<Record<string, unknown>> } {
	const call = vi.mocked(fetch).mock.calls.at(-1);
	if (!call) throw new Error("fetch was not called");
	return JSON.parse((call[1] as RequestInit).body as string);
}

const fetchMock = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" } as never);
	vi.mocked(decryptSecret).mockReturnValue({ url: WEBHOOK } as never);
});

afterEach(() => vi.unstubAllGlobals());

describe("slackSender.send — payload formatting", () => {
	it("POSTs to the decrypted webhook URL with JSON content-type and an abort signal", async () => {
		await slackSender.send(channel(), { title: "Hi", severity: "info" });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(WEBHOOK);
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({ "content-type": "application/json" });
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("sets fallback text and leads the title block with the severity emoji", async () => {
		await slackSender.send(channel(), { title: "Disk full", severity: "critical" });

		const body = lastBody();
		expect(body.text).toBe("Disk full");
		expect(body.blocks[0]).toEqual({
			type: "section",
			text: { type: "mrkdwn", text: ":rotating_light: *Disk full*" },
		});
	});

	it("defaults to the warning emoji when severity is omitted", async () => {
		await slackSender.send(channel(), { title: "Heads up" });
		const title = lastBody().blocks[0] as { text: { text: string } };
		expect(title.text.text).toBe(":warning: *Heads up*");
	});

	it("maps the info severity to its emoji", async () => {
		await slackSender.send(channel(), { title: "FYI", severity: "info" });
		const title = lastBody().blocks[0] as { text: { text: string } };
		expect(title.text.text).toBe(":information_source: *FYI*");
	});

	it("emits only the title block when no summary/details/link are present", async () => {
		await slackSender.send(channel(), { title: "Bare", severity: "info" });
		const body = lastBody();
		expect(body.blocks).toHaveLength(1);
		expect(body.blocks[0].type).toBe("section");
	});

	it("appends a summary section when summary is set", async () => {
		await slackSender.send(channel(), {
			title: "T",
			severity: "info",
			summary: "the long form explanation",
		});
		const body = lastBody();
		expect(body.blocks[1]).toEqual({
			type: "section",
			text: { type: "mrkdwn", text: "the long form explanation" },
		});
	});

	it("renders populated detail fields as a joined context block", async () => {
		const context: AlertEventContext = {
			title: "Policy denied",
			severity: "warning",
			actor_id: "user_42",
			action: "project.apply",
			resource_type: "project",
			resource_id: "prj_9",
			reason: "budget exceeded",
			job_id: "job_1",
			project_id: "prj_9",
			connector_slug: "aws-prod",
		};
		await slackSender.send(channel(), context);

		const ctxBlock = lastBody().blocks.find((b) => b.type === "context") as {
			elements: Array<{ type: string; text: string }>;
		};
		expect(ctxBlock.elements[0].type).toBe("mrkdwn");
		expect(ctxBlock.elements[0].text).toBe(
			"*actor* user_42  ·  *action* project.apply  ·  *resource* project prj_9  ·  *reason* budget exceeded  ·  *job* job_1  ·  *project* prj_9  ·  *connector* aws-prod",
		);
	});

	it("omits resource_id from the resource detail when only resource_type is set", async () => {
		await slackSender.send(channel(), {
			title: "T",
			severity: "info",
			resource_type: "runner",
		});
		const ctxBlock = lastBody().blocks.find((b) => b.type === "context") as {
			elements: Array<{ text: string }>;
		};
		expect(ctxBlock.elements[0].text).toBe("*resource* runner");
	});

	it("does not emit a context block when no detail fields are populated", async () => {
		await slackSender.send(channel(), { title: "T", severity: "info", summary: "s" });
		expect(lastBody().blocks.some((b) => b.type === "context")).toBe(false);
	});

	it("adds an actions button block linking to the console when link is set", async () => {
		await slackSender.send(channel(), {
			title: "T",
			severity: "info",
			link: "https://console.alethialabs.io/org/~/alerts/1",
		});
		const actions = lastBody().blocks.find((b) => b.type === "actions") as {
			elements: Array<{ type: string; text: { text: string }; url: string }>;
		};
		expect(actions.elements[0]).toEqual({
			type: "button",
			text: { type: "plain_text", text: "Open in console" },
			url: "https://console.alethialabs.io/org/~/alerts/1",
		});
	});
});

describe("slackSender.send — failure paths", () => {
	it("throws with status + statusText when Slack responds non-2xx", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" } as never);
		await expect(slackSender.send(channel(), { title: "T" })).rejects.toThrow(
			"Slack responded 404 Not Found",
		);
	});

	it("throws when the channel has no webhook URL configured", async () => {
		vi.mocked(decryptSecret).mockReturnValue({} as never);
		await expect(slackSender.send(channel(), { title: "T" })).rejects.toThrow(
			"Slack channel has no webhook URL configured",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("treats a missing channel secret as an empty config (no URL → throws)", async () => {
		await expect(slackSender.send(channel(null), { title: "T" })).rejects.toThrow(
			"Slack channel has no webhook URL configured",
		);
		// decryptSecret is skipped entirely when channel.secret is falsy.
		expect(vi.mocked(decryptSecret)).not.toHaveBeenCalled();
	});
});

describe("slackSender.verify", () => {
	it("posts the synthetic TEST_CONTEXT payload and resolves on success", async () => {
		await expect(slackSender.verify(channel())).resolves.toBeUndefined();
		const body = lastBody();
		expect(body.text).toBe(TEST_CONTEXT.title);
		const title = body.blocks[0] as { text: { text: string } };
		expect(title.text.text).toBe(`:information_source: *${TEST_CONTEXT.title}*`);
		// the test context carries a summary → a second section block
		expect(body.blocks[1]).toEqual({
			type: "section",
			text: { type: "mrkdwn", text: TEST_CONTEXT.summary },
		});
	});

	it("propagates a non-ok Slack response as a throw", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" } as never);
		await expect(slackSender.verify(channel())).rejects.toThrow("Slack responded 500 Server Error");
	});
});
