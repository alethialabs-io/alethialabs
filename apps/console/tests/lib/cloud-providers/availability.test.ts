// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The server's answer to "which clouds does this deployment offer". The offered set is fixed here
// BY DECISION (2026-11-17): AWS, GCP, Azure and Hetzner are offered; Alibaba, DigitalOcean and Civo
// are hidden. Deriving the expectation from the catalog would pass on any catalog.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertCloudOffered,
	CloudNotOfferedError,
	enabledHiddenClouds,
	HIDDEN_CLOUDS_ENV,
	HiddenCloudsConfigError,
	isCloudOffered,
	offeredClouds,
	withHiddenClouds,
} from "@/lib/cloud-providers/availability";

/** Returns the thrown value of `fn`, or fails the test when it does not throw. */
function thrownBy(fn: () => unknown): unknown {
	try {
		fn();
	} catch (err) {
		return err;
	}
	throw new Error("expected a throw");
}

let saved: string | undefined;

beforeEach(() => {
	saved = process.env[HIDDEN_CLOUDS_ENV];
	delete process.env[HIDDEN_CLOUDS_ENV];
});

afterEach(() => {
	if (saved === undefined) delete process.env[HIDDEN_CLOUDS_ENV];
	else process.env[HIDDEN_CLOUDS_ENV] = saved;
});

describe("with the setting unset", () => {
	it("offers the four launch clouds, in catalog order", () => {
		expect(offeredClouds()).toEqual(["aws", "gcp", "azure", "hetzner"]);
	});

	it("does not offer a hidden cloud", () => {
		for (const slug of ["alibaba", "digitalocean", "civo"]) {
			expect(isCloudOffered(slug)).toBe(false);
		}
	});

	it("does not offer something that is not a cloud", () => {
		for (const slug of ["", "AWS", " aws", "nimbus", "toString"]) {
			expect(isCloudOffered(slug)).toBe(false);
		}
	});

	it("names nothing as re-enabled", () => {
		expect(enabledHiddenClouds()).toEqual([]);
	});
});

describe("assertCloudOffered", () => {
	it("passes for an offered cloud", () => {
		expect(() => assertCloudOffered("hetzner")).not.toThrow();
	});

	it("refuses a hidden cloud by its full name, with no reason and no date", () => {
		const err = thrownBy(() => assertCloudOffered("alibaba"));
		expect(err).toBeInstanceOf(CloudNotOfferedError);
		if (!(err instanceof CloudNotOfferedError)) return;
		expect(err.message).toBe("Alibaba Cloud is not available in this release.");
		expect(err.slug).toBe("alibaba");
	});

	it("refuses an unknown slug without echoing it in the message", () => {
		const err = thrownBy(() => assertCloudOffered("nimbus"));
		expect(err).toBeInstanceOf(CloudNotOfferedError);
		if (!(err instanceof CloudNotOfferedError)) return;
		expect(err.message).toBe("This cloud is not available in this release.");
		expect(err.slug).toBe("nimbus");
	});
});

describe("the operator setting", () => {
	it("re-enables exactly the hidden cloud it names", () => {
		process.env[HIDDEN_CLOUDS_ENV] = "alibaba";
		expect(offeredClouds()).toEqual(["aws", "gcp", "azure", "alibaba", "hetzner"]);
		expect(isCloudOffered("alibaba")).toBe(true);
		expect(isCloudOffered("civo")).toBe(false);
		expect(() => assertCloudOffered("alibaba")).not.toThrow();
	});

	it("accepts spaces, blank items and repeats", () => {
		process.env[HIDDEN_CLOUDS_ENV] = " civo , ,alibaba,civo,";
		expect(enabledHiddenClouds()).toEqual(["civo", "alibaba"]);
		expect(offeredClouds()).toEqual(["aws", "gcp", "azure", "alibaba", "hetzner", "civo"]);
	});

	it("cannot remove an available cloud", () => {
		process.env[HIDDEN_CLOUDS_ENV] = "aws";
		expect(offeredClouds()).toEqual(["aws", "gcp", "azure", "hetzner"]);
	});

	it("treats an empty value as unset", () => {
		process.env[HIDDEN_CLOUDS_ENV] = "";
		expect(offeredClouds()).toEqual(["aws", "gcp", "azure", "hetzner"]);
	});

	it("fails on an item that is not a cloud slug, naming every such item", () => {
		process.env[HIDDEN_CLOUDS_ENV] = "alibaba,nimbus,Civo";
		const err = thrownBy(() => offeredClouds());
		expect(err).toBeInstanceOf(HiddenCloudsConfigError);
		if (!(err instanceof HiddenCloudsConfigError)) return;
		expect(err.unknown).toEqual(["nimbus", "Civo"]);
		expect(err.message).toContain("ALETHIA_ENABLE_HIDDEN_CLOUDS");
		expect(() => isCloudOffered("aws")).toThrow(HiddenCloudsConfigError);
	});
});

describe("withHiddenClouds", () => {
	it("offers the named clouds inside the callback only", async () => {
		const inside = await withHiddenClouds(["alibaba"], () => isCloudOffered("alibaba"));
		expect(inside).toBe(true);
		expect(isCloudOffered("alibaba")).toBe(false);
		expect(process.env[HIDDEN_CLOUDS_ENV]).toBeUndefined();
	});

	it("awaits an async callback before restoring", async () => {
		const inside = await withHiddenClouds(["civo"], async () => {
			await Promise.resolve();
			return offeredClouds();
		});
		expect(inside).toEqual(["aws", "gcp", "azure", "hetzner", "civo"]);
		expect(isCloudOffered("civo")).toBe(false);
	});

	it("puts a previous value back, also when the callback throws", async () => {
		process.env[HIDDEN_CLOUDS_ENV] = "civo";
		await expect(
			withHiddenClouds(["alibaba"], () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(process.env[HIDDEN_CLOUDS_ENV]).toBe("civo");
	});

	it("replaces the setting, it does not add to it", async () => {
		process.env[HIDDEN_CLOUDS_ENV] = "civo";
		const inside = await withHiddenClouds(["alibaba"], () => offeredClouds());
		expect(inside).toEqual(["aws", "gcp", "azure", "alibaba", "hetzner"]);
	});
});
