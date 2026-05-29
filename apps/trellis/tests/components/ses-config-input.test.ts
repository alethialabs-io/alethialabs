import { describe, expect, it } from "vitest";
import {
	serializeSesConfig,
	parseSesConfig,
} from "@/components/configuration/ses-config-input";

describe("SES Config serialization", () => {
	it("serializes queues and topics to YAML", () => {
		const queues = [{ name: "email-queue", visibility_timeout: 300 }];
		const topics = [{ name: "user-events", subscriptions: ["email-queue"] }];
		const yaml = serializeSesConfig(queues, topics);
		expect(yaml).toContain("queues:");
		expect(yaml).toContain("email-queue");
		expect(yaml).toContain("visibility_timeout: 300");
		expect(yaml).toContain("topics:");
		expect(yaml).toContain("user-events");
	});

	it("handles empty arrays", () => {
		expect(serializeSesConfig([], [])).toBe("");
	});

	it("serializes queues only", () => {
		const yaml = serializeSesConfig(
			[{ name: "q1", visibility_timeout: 60 }],
			[],
		);
		expect(yaml).toContain("queues:");
		expect(yaml).not.toContain("topics:");
	});

	it("filters out empty names", () => {
		const yaml = serializeSesConfig(
			[
				{ name: "", visibility_timeout: 300 },
				{ name: "valid", visibility_timeout: 60 },
			],
			[],
		);
		expect(yaml).not.toContain("- name: \n");
		expect(yaml).toContain("valid");
	});
});

describe("SES Config parsing", () => {
	it("parses queues from YAML", () => {
		const yaml = `queues:
  - name: email-processing
    visibility_timeout: 300
  - name: notification-queue
    visibility_timeout: 600`;
		const { queues } = parseSesConfig(yaml);
		expect(queues).toHaveLength(2);
		expect(queues[0].name).toBe("email-processing");
		expect(queues[0].visibility_timeout).toBe(300);
	});

	it("returns empty for empty string", () => {
		const { queues, topics } = parseSesConfig("");
		expect(queues).toEqual([]);
		expect(topics).toEqual([]);
	});
});
