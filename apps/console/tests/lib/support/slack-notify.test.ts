// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Tests for the out-of-band Slack notifier. It must be a no-op when SUPPORT_SLACK_WEBHOOK_URL is
// unset (the default OSS self-host — fetch never called), POST the Block Kit body when set, and
// NEVER throw even if the underlying fetch rejects (a failed notify must not fail the customer's
// submit/reply).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	notifySupportSlack,
	slackCaseCreated,
	slackCaseReplied,
} from "@/lib/support/slack-notify";

const ORIGINAL_WEBHOOK = process.env.SUPPORT_SLACK_WEBHOOK_URL;

/** A representative payload for the notifier. */
const payload = {
	text: "New support case",
	caseNumber: 42,
	subject: "Cluster is unreachable",
	severity: "high",
	orgId: "org-1",
	url: "http://localhost:3000",
} as const;

beforeEach(() => {
	vi.restoreAllMocks();
	delete process.env.SUPPORT_SLACK_WEBHOOK_URL;
});

afterEach(() => {
	if (ORIGINAL_WEBHOOK === undefined) delete process.env.SUPPORT_SLACK_WEBHOOK_URL;
	else process.env.SUPPORT_SLACK_WEBHOOK_URL = ORIGINAL_WEBHOOK;
});

describe("notifySupportSlack", () => {
	it("is a no-op when SUPPORT_SLACK_WEBHOOK_URL is unset (fetch not called)", async () => {
		const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response(null));
		await notifySupportSlack(payload);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("POSTs the webhook with a JSON body containing text + blocks when set", async () => {
		process.env.SUPPORT_SLACK_WEBHOOK_URL = "https://hooks.slack.test/abc";
		const fetchSpy = vi
			.spyOn(global, "fetch")
			.mockResolvedValue(new Response(null, { status: 200 }));

		await notifySupportSlack(payload);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe("https://hooks.slack.test/abc");
		expect(init?.method).toBe("POST");
		const body = JSON.parse(String(init?.body));
		expect(body.text).toBe("New support case");
		expect(Array.isArray(body.blocks)).toBe(true);
		// the context block carries the zero-padded case number
		expect(JSON.stringify(body.blocks)).toContain("CASE-000042");
	});

	it("never throws when fetch rejects", async () => {
		process.env.SUPPORT_SLACK_WEBHOOK_URL = "https://hooks.slack.test/abc";
		vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(notifySupportSlack(payload)).resolves.toBeUndefined();
	});
});

describe("slackCaseCreated / slackCaseReplied", () => {
	it("both no-op when the webhook is unset", async () => {
		const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response(null));
		await slackCaseCreated({ caseNumber: 1, subject: "s", severity: "low" });
		await slackCaseReplied({ caseNumber: 1, subject: "s", severity: "low" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("post distinct header text when the webhook is set", async () => {
		process.env.SUPPORT_SLACK_WEBHOOK_URL = "https://hooks.slack.test/abc";
		const fetchSpy = vi
			.spyOn(global, "fetch")
			.mockResolvedValue(new Response(null, { status: 200 }));

		await slackCaseCreated({ caseNumber: 1, subject: "s", severity: "low" });
		await slackCaseReplied({ caseNumber: 1, subject: "s", severity: "low" });

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const first = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
		const second = JSON.parse(String(fetchSpy.mock.calls[1][1]?.body));
		expect(first.text).toBe("New support case");
		expect(second.text).toBe("Customer replied to a case");
	});
});
