// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The SES webhook's topic allow-list (lib/email/ses-events-topic.ts): exact ARNs only, read from
// ALETHIA_SES_EVENTS_TOPIC_ARNS, and an unset or malformed value accepts NOTHING.

import { afterEach, describe, expect, it } from "vitest";

import {
	allowedSesEventsTopicArns,
	isAllowedSesEventsTopic,
	SES_EVENTS_TOPIC_ARNS_ENV,
} from "@/lib/email/ses-events-topic";

const OURS = "arn:aws:sns:eu-central-1:604925221417:alethia-ses-events";
const saved = process.env[SES_EVENTS_TOPIC_ARNS_ENV];

afterEach(() => {
	if (saved === undefined) delete process.env[SES_EVENTS_TOPIC_ARNS_ENV];
	else process.env[SES_EVENTS_TOPIC_ARNS_ENV] = saved;
});

describe("allowedSesEventsTopicArns", () => {
	it("is empty when the variable is unset or blank", () => {
		delete process.env[SES_EVENTS_TOPIC_ARNS_ENV];
		expect(allowedSesEventsTopicArns()).toEqual([]);
		process.env[SES_EVENTS_TOPIC_ARNS_ENV] = "  ";
		expect(allowedSesEventsTopicArns()).toEqual([]);
	});

	it("splits on commas and trims each entry", () => {
		const other = "arn:aws:sns:us-east-1:111111111111:self-hosted-events";
		process.env[SES_EVENTS_TOPIC_ARNS_ENV] = ` ${OURS} ,${other},`;
		expect(allowedSesEventsTopicArns()).toEqual([OURS, other]);
	});

	it("drops entries that are not full topic ARNs instead of matching them loosely", () => {
		process.env[SES_EVENTS_TOPIC_ARNS_ENV] = [
			"alethia-ses-events",
			":alethia-ses-events",
			"arn:aws:sns:eu-central-1:*:alethia-ses-events",
			"arn:aws:sns:eu-central-1:604925221417:*",
			"arn:aws:sqs:eu-central-1:604925221417:alethia-ses-events",
		].join(",");
		expect(allowedSesEventsTopicArns()).toEqual([]);
	});

	it("accepts ARNs in other partitions", () => {
		const gov = "arn:aws-us-gov:sns:us-gov-west-1:123456789012:events";
		process.env[SES_EVENTS_TOPIC_ARNS_ENV] = gov;
		expect(allowedSesEventsTopicArns()).toEqual([gov]);
	});
});

describe("isAllowedSesEventsTopic", () => {
	it("accepts only an exact match", () => {
		process.env[SES_EVENTS_TOPIC_ARNS_ENV] = OURS;
		expect(isAllowedSesEventsTopic(OURS)).toBe(true);
		expect(isAllowedSesEventsTopic("arn:aws:sns:eu-central-1:999999999999:alethia-ses-events")).toBe(false);
		expect(isAllowedSesEventsTopic("arn:aws:sns:us-east-1:604925221417:alethia-ses-events")).toBe(false);
		expect(isAllowedSesEventsTopic(`${OURS}-2`)).toBe(false);
	});

	it("accepts nothing when nothing is configured", () => {
		delete process.env[SES_EVENTS_TOPIC_ARNS_ENV];
		expect(isAllowedSesEventsTopic(OURS)).toBe(false);
	});
});
