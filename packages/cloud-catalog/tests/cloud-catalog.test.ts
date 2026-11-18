// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The offered set is fixed here BY DECISION (2026-11-17): AWS, GCP, Azure and Hetzner are offered;
// Alibaba, DigitalOcean and Civo are hidden. Deriving the expectation from catalog.json would pass
// on any catalog, so the lists are written out. Changing a cloud's availability changes this file
// in the same diff, which is the review.

import { describe, expect, it } from "vitest";
import {
	ALL_CLOUDS,
	AVAILABLE_CLOUDS,
	CLOUD_AVAILABILITY,
	CLOUD_LABELS,
	HIDDEN_CLOUDS,
	PROVISIONABLE_CLOUDS,
	cloudListLabel,
	isCloudSlug,
} from "../src/index";

describe("the cloud sets", () => {
	it("lists every cloud in catalog order", () => {
		expect(ALL_CLOUDS).toEqual(["aws", "gcp", "azure", "alibaba", "digitalocean", "hetzner", "civo"]);
	});

	it("offers the four launch clouds", () => {
		expect(AVAILABLE_CLOUDS).toEqual(["aws", "gcp", "azure", "hetzner"]);
	});

	it("hides Alibaba, DigitalOcean and Civo", () => {
		expect(HIDDEN_CLOUDS).toEqual(["alibaba", "digitalocean", "civo"]);
	});

	it("can provision on every offered cloud and on no hidden one", () => {
		expect(PROVISIONABLE_CLOUDS).toEqual(["aws", "gcp", "azure", "hetzner"]);
	});

	it("puts every cloud in exactly one of available and hidden", () => {
		expect([...AVAILABLE_CLOUDS, ...HIDDEN_CLOUDS].sort()).toEqual([...ALL_CLOUDS].sort());
		expect(AVAILABLE_CLOUDS.filter((slug) => HIDDEN_CLOUDS.includes(slug))).toEqual([]);
	});

	it("agrees with the per-cloud availability map", () => {
		expect(Object.keys(CLOUD_AVAILABILITY)).toEqual([...ALL_CLOUDS]);
		expect(ALL_CLOUDS.filter((slug) => CLOUD_AVAILABILITY[slug] === "available")).toEqual([...AVAILABLE_CLOUDS]);
		expect(ALL_CLOUDS.filter((slug) => CLOUD_AVAILABILITY[slug] === "hidden")).toEqual([...HIDDEN_CLOUDS]);
	});

	it("has a non-empty label for every cloud", () => {
		expect(Object.keys(CLOUD_LABELS)).toEqual([...ALL_CLOUDS]);
		for (const slug of ALL_CLOUDS) expect(CLOUD_LABELS[slug].length).toBeGreaterThan(0);
	});
});

describe("isCloudSlug", () => {
	it("accepts a hidden cloud as well as an offered one", () => {
		expect(isCloudSlug("aws")).toBe(true);
		expect(isCloudSlug("alibaba")).toBe(true);
	});

	it("refuses anything that is not exactly a catalog slug", () => {
		for (const value of ["", "AWS", " aws", "nimbus", "toString", "constructor", "__proto__"]) {
			expect(isCloudSlug(value)).toBe(false);
		}
	});
});

describe("cloudListLabel", () => {
	it("names the offered clouds by default", () => {
		expect(cloudListLabel()).toBe("AWS, GCP, Azure and Hetzner");
	});

	it("joins two names with 'and' and no comma", () => {
		expect(cloudListLabel(["aws", "gcp"])).toBe("AWS and GCP");
	});

	it("gives one name alone", () => {
		expect(cloudListLabel(["hetzner"])).toBe("Hetzner");
	});

	it("gives an empty string for no clouds", () => {
		expect(cloudListLabel([])).toBe("");
	});

	it("keeps the order it is given and labels a hidden cloud", () => {
		expect(cloudListLabel(["hetzner", "alibaba", "aws"])).toBe("Hetzner, Alibaba and AWS");
	});
});
