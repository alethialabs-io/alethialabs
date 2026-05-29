import { describe, expect, it } from "vitest";
import {
	serializeEksAdmins,
	parseEksAdmins,
} from "@/components/configuration/eks-admins-input";

describe("EKS Admins serialization", () => {
	it("serializes admins to YAML", () => {
		const admins = [
			{ username: "alice@example.com", path: "/" },
			{ username: "bob@example.com", path: "/users/" },
		];
		const yaml = serializeEksAdmins(admins);
		expect(yaml).toContain("eks_cluster_admins:");
		expect(yaml).toContain("alice@example.com");
		expect(yaml).toContain("bob@example.com");
		expect(yaml).toContain("path: /users/");
	});

	it("filters out empty usernames", () => {
		const admins = [
			{ username: "", path: "/" },
			{ username: "valid@example.com", path: "/" },
		];
		const yaml = serializeEksAdmins(admins);
		expect(yaml).not.toContain('""');
		expect(yaml).toContain("valid@example.com");
	});

	it("returns empty string for no admins", () => {
		expect(serializeEksAdmins([])).toBe("");
	});

	it("returns empty string when all admins have empty usernames", () => {
		expect(serializeEksAdmins([{ username: "", path: "/" }])).toBe("");
	});
});

describe("EKS Admins parsing", () => {
	it("parses YAML back to admins", () => {
		const yaml = `eks_cluster_admins:
  - username: "alice@example.com"
    path: /
  - username: "bob@example.com"
    path: /users/`;
		const admins = parseEksAdmins(yaml);
		expect(admins).toHaveLength(2);
		expect(admins[0].username).toBe("alice@example.com");
		expect(admins[1].path).toBe("/users/");
	});

	it("returns empty array for empty string", () => {
		expect(parseEksAdmins("")).toEqual([]);
	});

	it("round-trips correctly", () => {
		const original = [
			{ username: "test@test.com", path: "/" },
			{ username: "admin@corp.com", path: "/admins/" },
		];
		const yaml = serializeEksAdmins(original);
		const parsed = parseEksAdmins(yaml);
		expect(parsed).toHaveLength(2);
		expect(parsed[0].username).toBe("test@test.com");
		expect(parsed[1].username).toBe("admin@corp.com");
	});
});
