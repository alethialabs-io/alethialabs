// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Alerts hub's filter/query plumbing (components/alerts/alerts-query.ts +
// alerts-status.ts + lib/stores/use-alerts-filters.ts): the normalize step's
// key-stability guarantees, the status/kind bucketing the badges and the chip labels
// read, and the drift guards keeping the client-side value lists in lockstep with the
// alert_* DB enums.
//
// The RESOLVE step and the facet-over-the-UNFILTERED-universe rule are NOT here any more.
// #4890 moved both into SQL, so they are asserted where they now live: the per-builder
// behaviour in tests/lib/queries/alerts-lists.test.ts, and the two-pass invariant itself in
// tests/lib/queries/filter-standard-facets.test.ts, which drives all three alert builders.

import { describe, expect, it } from "vitest";
import type {
	ChannelDTO,
	DeliveryDTO,
	PolicyDTO,
} from "@/app/server/actions/alerts";
import { CHANNEL_TYPE_ORDER } from "@/components/alerts/channel-meta";
import {
	CHANNEL_STATUS_VALUES,
	channelStatusKey,
	DEFAULT_ACTIVITY_FILTERS,
	DEFAULT_CHANNEL_FILTERS,
	DEFAULT_POLICY_FILTERS,
	DELIVERY_STATUS_LABEL,
	normalizeActivityQuery,
	normalizeChannelsQuery,
	normalizePoliciesQuery,
	policyKindKey,
	policyStatusKey,
} from "@/components/alerts/alerts-query";
import {
	channelBadge,
	deliveryBadge,
	policyBadge,
} from "@/components/alerts/alerts-status";
import { alertChannelType, alertDeliveryStatus } from "@/lib/db/schema/enums";
import {
	useAlertActivityFilters,
	useAlertChannelFilters,
	useAlertPolicyFilters,
} from "@/lib/stores/use-alerts-filters";

/** A channel fixture; every field the filter layer reads is overridable. */
function channel(over: Partial<ChannelDTO> & { id: string }): ChannelDTO {
	return {
		type: "webhook",
		name: "Channel",
		enabled: true,
		is_verified: true,
		recipients: [],
		has_secret: true,
		last_verified_at: null,
		...over,
	};
}

/** A policy fixture; the match/severity fields are inert for filtering. */
function policy(over: Partial<PolicyDTO> & { id: string }): PolicyDTO {
	return {
		name: "Policy",
		description: null,
		event_patterns: [],
		is_security: false,
		severity: "warning",
		match: {},
		throttle_seconds: 0,
		escalate: false,
		recipient: null,
		enabled: true,
		channels: [],
		channelIds: [],
		...over,
	};
}

/** A delivery fixture for the ledger. */
function delivery(over: Partial<DeliveryDTO> & { id: string }): DeliveryDTO {
	return {
		event_key: "job.failed",
		status: "sent",
		title: "Job failed",
		attempts: 1,
		last_error: null,
		created_at: "2026-08-01T00:00:00.000Z",
		sent_at: null,
		...over,
	};
}

// Named fixtures rather than array indexing: `noUncheckedIndexedAccess` makes
// `CHANNELS[2]` a `ChannelDTO | undefined`, and a `!` at every call site would be noise.
const opsSlack = channel({ id: "c1", type: "slack", name: "Ops Slack" });
const onCallMail = channel({
	id: "c2",
	type: "email",
	name: "On-call mail",
	is_verified: false,
});
const securitySlack = channel({
	id: "c3",
	type: "slack",
	name: "Security Slack",
	enabled: false,
});
const auditSink = channel({ id: "c4", type: "webhook", name: "Audit sink" });
// Named for neither its type slug nor its own text — only the transport LABEL
// ("Google Chat") can match it, which is what pins that arm of the search.
const teamRoom = channel({ id: "c5", type: "googlechat", name: "Team room" });

const CHANNELS: ChannelDTO[] = [
	opsSlack,
	onCallMail,
	securitySlack,
	auditSink,
	teamRoom,
];

const deployFailures = policy({
	id: "p1",
	name: "Deploy failures",
	channelIds: ["c1"],
});
const authzDenials = policy({
	id: "p2",
	name: "Authz denials",
	description: "PDP-sourced",
	is_security: true,
	channelIds: ["c1", "c2"],
});
const nightlyDrift = policy({
	id: "p3",
	name: "Nightly drift",
	enabled: false,
	channelIds: [],
});

const POLICIES: PolicyDTO[] = [deployFailures, authzDenials, nightlyDrift];

// event_key is overridden on every fixture, not left to the factory default. The default is
// "job.failed", and a search test for that string matched all three rows while asserting one —
// the fixture defeated its own assertion. Distinct keys make the search test able to fail.
const sentDelivery = delivery({
	id: "d1",
	status: "sent",
	title: "Cluster ready",
	event_key: "cluster.ready",
});
const failedDelivery = delivery({
	id: "d2",
	status: "failed",
	title: "Webhook 500",
	event_key: "job.failed",
});
const deadDelivery = delivery({
	id: "d3",
	status: "dead",
	title: "Webhook 500",
	event_key: "deploy.succeeded",
});

const DELIVERIES: DeliveryDTO[] = [sentDelivery, failedDelivery, deadDelivery];

describe("drift guards", () => {
	it("orders every alert_channel_type from the DB enum", () => {
		expect([...CHANNEL_TYPE_ORDER].sort()).toEqual(
			[...alertChannelType.enumValues].sort(),
		);
	});

	it("labels every alert_delivery_status the DB enum can produce", () => {
		// The chip ROW's order moved to lib/queries/alerts-lists.ts with the facet that
		// produces it (#4890); what stays client-side is the label map, and the drift this
		// guards is a new enum value arriving with no human string for it.
		expect(Object.keys(DELIVERY_STATUS_LABEL).sort()).toEqual(
			[...alertDeliveryStatus.enumValues].sort(),
		);
	});

	it("buckets a channel into exactly one status value", () => {
		for (const c of CHANNELS) {
			expect(CHANNEL_STATUS_VALUES).toContain(channelStatusKey(c));
		}
	});
});

describe("status keys", () => {
	it("reads paused before verified — a disabled channel is never 'Verified'", () => {
		expect(channelStatusKey(securitySlack)).toBe("paused");
		expect(channelStatusKey(opsSlack)).toBe("verified");
		expect(channelStatusKey(onCallMail)).toBe("unverified");
	});

	it("splits policies by enabled and by security provenance", () => {
		expect(policyStatusKey(deployFailures)).toBe("enabled");
		expect(policyStatusKey(nightlyDrift)).toBe("off");
		expect(policyKindKey(authzDenials)).toBe("security");
		expect(policyKindKey(deployFailures)).toBe("operational");
	});
});

describe("normalize (query-key stability)", () => {
	it("drops empty fields so a pristine view keys as {}", () => {
		expect(normalizeChannelsQuery(DEFAULT_CHANNEL_FILTERS)).toEqual({});
		expect(normalizePoliciesQuery(DEFAULT_POLICY_FILTERS)).toEqual({});
		expect(normalizeActivityQuery(DEFAULT_ACTIVITY_FILTERS)).toEqual({});
	});

	it("trims the search term", () => {
		expect(
			normalizeChannelsQuery({ ...DEFAULT_CHANNEL_FILTERS, search: "  ops " }),
		).toEqual({ search: "ops" });
		// Whitespace alone is not a filter.
		expect(
			normalizeChannelsQuery({ ...DEFAULT_CHANNEL_FILTERS, search: "   " }),
		).toEqual({});
	});

	it("sorts and dedupes selections, so equivalent states share one key", () => {
		const a = normalizeChannelsQuery({
			...DEFAULT_CHANNEL_FILTERS,
			types: ["slack", "email", "slack"],
		});
		const b = normalizeChannelsQuery({
			...DEFAULT_CHANNEL_FILTERS,
			types: ["email", "slack"],
		});
		expect(a).toEqual({ types: ["email", "slack"] });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("normalizes every policy and activity selection the same way", () => {
		expect(
			normalizePoliciesQuery({
				search: " drift ",
				status: ["off", "enabled", "off"],
				kinds: ["security"],
				channels: ["c2", "c1"],
			}),
		).toEqual({
			search: "drift",
			status: ["enabled", "off"],
			kinds: ["security"],
			channels: ["c1", "c2"],
		});
		expect(
			normalizeActivityQuery({ search: "", status: ["dead", "sent", "dead"] }),
		).toEqual({ status: ["dead", "sent"] });
	});
});

describe("status badges", () => {
	it("reads a paused channel as disabled, not idle", () => {
		expect(channelBadge(securitySlack)).toEqual({
			status: "paused",
			tier: "disabled",
			label: "Paused",
		});
		expect(channelBadge(onCallMail).tier).toBe("idle");
		expect(channelBadge(opsSlack).tier).toBe("active");
	});

	it("reads an off policy as disabled and an enabled one as active", () => {
		expect(policyBadge(deployFailures).tier).toBe("active");
		expect(policyBadge(nightlyDrift)).toEqual({
			status: "off",
			tier: "disabled",
			label: "Off",
		});
	});

	it("reads a retry-exhausted delivery as a failure", () => {
		expect(deliveryBadge("dead").tier).toBe("failed");
		expect(deliveryBadge("failed").tier).toBe("failed");
		expect(deliveryBadge("pending").tier).toBe("pending");
		expect(deliveryBadge("sent").tier).toBe("active");
	});

	it("labels every delivery status the DB enum can produce", () => {
		for (const status of alertDeliveryStatus.enumValues) {
			expect(deliveryBadge(status).label).toBeTruthy();
		}
	});
});

describe("the hub's three filter stores", () => {
	it("start pristine and reset back to their defaults", () => {
		expect(useAlertChannelFilters.getState().filters).toEqual(
			DEFAULT_CHANNEL_FILTERS,
		);
		expect(useAlertPolicyFilters.getState().filters).toEqual(DEFAULT_POLICY_FILTERS);
		expect(useAlertActivityFilters.getState().filters).toEqual(
			DEFAULT_ACTIVITY_FILTERS,
		);

		useAlertChannelFilters.getState().set("types", ["slack"]);
		expect(useAlertChannelFilters.getState().filters.types).toEqual(["slack"]);
		useAlertChannelFilters.getState().reset();
		expect(useAlertChannelFilters.getState().filters).toEqual(
			DEFAULT_CHANNEL_FILTERS,
		);
	});

	it("are independent — resetting one panel leaves the others alone", () => {
		useAlertPolicyFilters.getState().patch({ search: "drift" });
		useAlertActivityFilters.getState().set("status", ["failed"]);
		useAlertChannelFilters.getState().reset();

		expect(useAlertPolicyFilters.getState().filters.search).toBe("drift");
		expect(useAlertActivityFilters.getState().filters.status).toEqual(["failed"]);

		useAlertPolicyFilters.getState().reset();
		useAlertActivityFilters.getState().reset();
	});
});
