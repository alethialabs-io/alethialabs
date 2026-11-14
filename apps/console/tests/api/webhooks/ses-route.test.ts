// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The SES event webhook (app/api/webhooks/ses/route.ts): which topics it accepts, and what it does
// with a message from one. Signature verification has its own suite (sns-signature.test.ts) and is
// mocked here, as is the suppression write; the route's own decisions are what is under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { verifySnsSignature, recordSuppression } = vi.hoisted(() => ({
	verifySnsSignature: vi.fn(),
	recordSuppression: vi.fn(),
}));
vi.mock("@/lib/email/sns-signature", () => ({ verifySnsSignature }));
vi.mock("@/lib/email/suppression", () => ({ recordSuppression }));

import { POST } from "@/app/api/webhooks/ses/route";
import { SES_EVENTS_TOPIC_ARNS_ENV } from "@/lib/email/ses-events-topic";

const NEW_TOPIC = "arn:aws:sns:eu-central-1:604925221417:alethia-ses-events";
const saved = process.env[SES_EVENTS_TOPIC_ARNS_ENV];
const fetchMock = vi.fn();

/** An SNS envelope as the route receives it; the signature itself is mocked. */
function envelope(over: Record<string, string> = {}): Record<string, string> {
	return {
		Type: "Notification",
		MessageId: "11111111-2222-3333-4444-555555555555",
		TopicArn: NEW_TOPIC,
		Message: JSON.stringify({
			eventType: "Bounce",
			mail: { messageId: "ses-msg-1" },
			bounce: {
				bounceType: "Permanent",
				bounceSubType: "General",
				feedbackId: "fb-1",
				bouncedRecipients: [{ emailAddress: "gone@example.com", diagnosticCode: "550" }],
			},
		}),
		Timestamp: "2026-11-14T12:00:00.000Z",
		Signature: "c2ln",
		SignatureVersion: "2",
		SigningCertURL: "https://sns.eu-central-1.amazonaws.com/cert.pem",
		...over,
	};
}

/** POSTs a body to the route. */
async function post(body: unknown): Promise<Response> {
	return POST(
		new Request("http://local/api/webhooks/ses", {
			method: "POST",
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	);
}

beforeEach(() => {
	verifySnsSignature.mockReset().mockResolvedValue(true);
	recordSuppression.mockReset().mockResolvedValue(undefined);
	fetchMock.mockReset().mockResolvedValue(new Response("ok"));
	vi.stubGlobal("fetch", fetchMock);
	process.env[SES_EVENTS_TOPIC_ARNS_ENV] = NEW_TOPIC;
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (saved === undefined) delete process.env[SES_EVENTS_TOPIC_ARNS_ENV];
	else process.env[SES_EVENTS_TOPIC_ARNS_ENV] = saved;
});

describe("POST /api/webhooks/ses — which topics", () => {
	it("refuses every message with 503 while no topic is configured", async () => {
		delete process.env[SES_EVENTS_TOPIC_ARNS_ENV];
		const res = await post(envelope());
		expect(res.status).toBe(503);
		expect(await res.text()).toContain(SES_EVENTS_TOPIC_ARNS_ENV);
		expect(verifySnsSignature).not.toHaveBeenCalled();
		expect(recordSuppression).not.toHaveBeenCalled();
	});

	it("refuses an unlisted topic before checking its signature", async () => {
		const res = await post(
			envelope({ TopicArn: "arn:aws:sns:eu-central-1:999999999999:alethia-ses-events" }),
		);
		expect(res.status).toBe(403);
		expect(verifySnsSignature).not.toHaveBeenCalled();
		expect(recordSuppression).not.toHaveBeenCalled();
	});

	it("refuses a subscription confirmation from an unlisted topic without visiting its URL", async () => {
		const res = await post(
			envelope({
				Type: "SubscriptionConfirmation",
				TopicArn: "arn:aws:sns:eu-central-1:999999999999:alethia-ses-events",
				Token: "t",
				SubscribeURL: "https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription",
			}),
		);
		expect(res.status).toBe(403);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses a listed topic whose signature does not verify", async () => {
		verifySnsSignature.mockResolvedValue(false);
		const res = await post(envelope());
		expect(res.status).toBe(403);
		expect(recordSuppression).not.toHaveBeenCalled();
	});
});

describe("POST /api/webhooks/ses — a message from a listed topic", () => {
	it("confirms the subscription by visiting the signed SubscribeURL", async () => {
		const url = "https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=t";
		const res = await post(envelope({ Type: "SubscriptionConfirmation", Token: "t", SubscribeURL: url }));
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledWith(url);
	});

	it("suppresses each recipient of a permanent bounce", async () => {
		const res = await post(envelope());
		expect(res.status).toBe(200);
		expect(recordSuppression).toHaveBeenCalledTimes(1);
		expect(recordSuppression).toHaveBeenCalledWith(
			expect.objectContaining({ email: "gone@example.com", reason: "bounce" }),
		);
	});

	it("accepts any topic in a multi-entry list", async () => {
		const old = "arn:aws:sns:eu-central-1:123456789012:alethia-ses-events";
		process.env[SES_EVENTS_TOPIC_ARNS_ENV] = `${old},${NEW_TOPIC}`;
		expect((await post(envelope({ TopicArn: old }))).status).toBe(200);
		expect((await post(envelope())).status).toBe(200);
	});

	it("acknowledges SES's plain-text topic-validation note without acting on it", async () => {
		const res = await post(
			envelope({ Message: "Successfully validated SNS topic for Amazon SES event publishing." }),
		);
		expect(res.status).toBe(200);
		expect(recordSuppression).not.toHaveBeenCalled();
	});

	it("leaves a transient bounce alone", async () => {
		const res = await post(
			envelope({
				Message: JSON.stringify({
					eventType: "Bounce",
					bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "busy@example.com" }] },
				}),
			}),
		);
		expect(res.status).toBe(200);
		expect(recordSuppression).not.toHaveBeenCalled();
	});
});
