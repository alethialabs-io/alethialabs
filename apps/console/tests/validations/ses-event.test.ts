// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { sesEventSchema, snsMessageSchema } from "@/lib/validations/ses-event";

describe("snsMessageSchema", () => {
	it("accepts a Notification envelope", () => {
		const r = snsMessageSchema.safeParse({
			Type: "Notification",
			MessageId: "id",
			TopicArn: "arn:aws:sns:eu-central-1:1:alethia-ses-events",
			Message: "{}",
			Timestamp: "2026-01-01T00:00:00Z",
			Signature: "sig",
			SignatureVersion: "1",
			SigningCertURL: "https://sns.eu-central-1.amazonaws.com/cert.pem",
		});
		expect(r.success).toBe(true);
	});

	it("rejects an unknown type and a non-URL cert", () => {
		expect(snsMessageSchema.safeParse({ Type: "Bogus" }).success).toBe(false);
	});
});

describe("sesEventSchema", () => {
	it("normalizes eventType/notificationType into `type`", () => {
		expect(sesEventSchema.parse({ eventType: "Bounce" }).type).toBe("Bounce");
		expect(sesEventSchema.parse({ notificationType: "Complaint" }).type).toBe(
			"Complaint",
		);
	});

	it("parses a permanent bounce with its recipients", () => {
		const e = sesEventSchema.parse({
			eventType: "Bounce",
			mail: { messageId: "m-1" },
			bounce: {
				bounceType: "Permanent",
				bounceSubType: "General",
				feedbackId: "fb-1",
				bouncedRecipients: [
					{ emailAddress: "dead@example.com", diagnosticCode: "550 no" },
				],
			},
		});
		expect(e.type).toBe("Bounce");
		expect(e.bounce?.bounceType).toBe("Permanent");
		expect(e.bounce?.bouncedRecipients[0].emailAddress).toBe("dead@example.com");
	});

	it("defaults missing recipient arrays to empty", () => {
		const e = sesEventSchema.parse({ eventType: "Bounce", bounce: {} });
		expect(e.bounce?.bouncedRecipients).toEqual([]);
	});

	it("parses a complaint", () => {
		const e = sesEventSchema.parse({
			eventType: "Complaint",
			complaint: {
				complaintFeedbackType: "abuse",
				complainedRecipients: [{ emailAddress: "angry@example.com" }],
			},
		});
		expect(e.type).toBe("Complaint");
		expect(e.complaint?.complainedRecipients[0].emailAddress).toBe(
			"angry@example.com",
		);
	});
});
