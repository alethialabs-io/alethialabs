import { describe, expect, it } from "vitest";
import {
	serializeCidrTags,
	parseCidrTags,
} from "@/components/configuration/cidr-tag-input";

describe("CIDR Tags serialization", () => {
	it("joins CIDRs with commas", () => {
		expect(serializeCidrTags(["10.0.0.0/16", "172.16.0.0/12"])).toBe(
			"10.0.0.0/16,172.16.0.0/12",
		);
	});

	it("handles single CIDR", () => {
		expect(serializeCidrTags(["10.0.0.0/16"])).toBe("10.0.0.0/16");
	});

	it("handles empty array", () => {
		expect(serializeCidrTags([])).toBe("");
	});
});

describe("CIDR Tags parsing", () => {
	it("splits comma-separated CIDRs", () => {
		expect(parseCidrTags("10.0.0.0/16,172.16.0.0/12")).toEqual([
			"10.0.0.0/16",
			"172.16.0.0/12",
		]);
	});

	it("trims whitespace", () => {
		expect(parseCidrTags("10.0.0.0/16 , 172.16.0.0/12")).toEqual([
			"10.0.0.0/16",
			"172.16.0.0/12",
		]);
	});

	it("filters empty strings", () => {
		expect(parseCidrTags("10.0.0.0/16,,")).toEqual(["10.0.0.0/16"]);
	});

	it("returns empty for empty string", () => {
		expect(parseCidrTags("")).toEqual([]);
	});
});
