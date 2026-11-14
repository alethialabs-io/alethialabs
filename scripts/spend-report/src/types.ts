// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** The clouds the report reads, in the order the email lists them. */
export const CLOUDS = ["aws", "azure", "gcp", "hetzner", "alibaba"] as const;
export type CloudId = (typeof CLOUDS)[number];

/** Display names for each cloud. */
export const CLOUD_LABEL: Record<CloudId, string> = {
	aws: "AWS",
	azure: "Azure",
	gcp: "GCP",
	hetzner: "Hetzner",
	alibaba: "Alibaba",
};

/**
 * What a line item's amount covers. `7d` is the last seven complete UTC days; `mtd` is the month to
 * date; `est-7d` is a Hetzner-style estimate of seven days from list prices.
 */
export type Basis = "7d" | "mtd" | "est-7d";

/** One priced line (a service, a resource) in the cloud's native currency. */
export interface LineItem {
	label: string;
	amount: number;
}

/** A named breakdown shown under a cloud (spend by an `alethia:*` tag, by linked account). */
export interface Breakdown {
	title: string;
	items: LineItem[];
}

/** A cloud that answered. Any figure it could not produce is `null`, never 0. */
export interface CloudReading {
	cloud: CloudId;
	status: "ok";
	/** ISO 4217 code of every amount in this reading. */
	currency: string;
	last7: number | null;
	prior7: number | null;
	mtd: number | null;
	/** True when every figure is computed from list prices rather than read from a bill. */
	estimate: boolean;
	lineItemBasis: Basis;
	lineItems: LineItem[];
	breakdowns: Breakdown[];
	/** Plain statements the reader needs (a closed billing account, an un-activated tag). */
	notes: string[];
}

/** A cloud that could not be read, and why — the report says so instead of failing. */
export interface CloudUnreadable {
	cloud: CloudId;
	status: "unreadable";
	reason: string;
}

export type CloudResult = CloudReading | CloudUnreadable;

/** A resource that still exists while carrying an e2e/disposable handle. */
export interface Leak {
	cloud: CloudId;
	/** The provider's own identifier (an ARN, `server/12345`). */
	id: string;
	/** The resource type as the provider names it. */
	kind: string;
	/** The e2e run the handle attributes it to, e.g. `e2e-36135826614-1`. */
	handle: string;
	/** Which tag/label key produced the attribution. */
	key: "project-id" | "e2e-run";
}

/** The leak scan of one cloud. */
export type LeakResult =
	| { cloud: CloudId; status: "ok"; leaks: Leak[]; scope: string }
	| { cloud: CloudId; status: "unreadable"; reason: string };

/** Per-cloud red-flag ceilings, EUR per seven days. */
export type Thresholds = Record<CloudId, number>;
