// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `lib/tf-variables.mjs` is the DECLARATION half of the template-knob manifest: what a template says
// it accepts, with the type, the default and the prose a person needs to set it. Everything the card
// UI shows about a knob comes from here, so a reader that is quietly wrong produces a manifest that
// parses, renders, and lies — a required knob shown as optional, a defaulted one shown as blank, an
// expression rendered as if it were a value.
//
// The module carries its own `selfCheck()` (run by every guard that imports it, so CI cannot skip
// it). This suite is not a copy of it: it drives the reader over the shapes a TEMPLATE actually uses
// and pins the answers a UI depends on, in both directions — the failure that matters here is never
// "the reader crashed", it is "the reader answered confidently and wrongly".

import { describe, expect, it } from "vitest";

import { kindOf, objectAttributeTypesIn, parseHclLiteral, readTfVariables, selfCheck } from "../../scripts/lib/tf-variables.mjs";

/** One fixture template, in the shapes the five real ones use. Written as a `.tf` string rather than
 * read from disk so a template edit cannot silently change what this suite asserts. */
const FIXTURE = [
	{
		path: "fx/variables.tf",
		text: `
variable "cluster_name" {
  description = "The cluster's name."
  type        = string
}

variable "node_count" {
  description = "How many workers."
  type        = number
  default     = 3
}

variable "enable_logs" {
  type    = bool
  default = true
}

variable "allowed_cidr_blocks" {
  description = "Extra source ranges."
  type        = list(string)
  default     = []
}

variable "labels" {
  type    = map(string)
  default = { team = "platform" }
}

variable "scaling" {
  type = object({
    min = number
    max = number
  })
  default = { min = 1, max = 4 }
}

variable "buckets" {
  description = "One entry per bucket."
  type = list(object({
    name       = string
    versioning = optional(bool, false)
    cors       = optional(list(string), [])
  }))
  default = []
}

variable "admin_password" {
  type      = string
  sensitive = true
}

variable "opaque" {
  type = list(any)
}
`,
	},
	{
		path: "fx/connector-providers.tf",
		text: `
variable "pull_provider" {
  description = "Declared outside variables.tf, like a fifth of the real root variables."
  type        = string
  default     = ""
}
`,
	},
];

const read = () => new Map(readTfVariables(FIXTURE).map((v) => [v.name, v]));

describe("tf-variables selfCheck", () => {
	it("passes — the reader pins itself on every run, and this fails the suite when it stops", () => {
		expect(() => selfCheck()).not.toThrow();
	});
});

describe("readTfVariables", () => {
	it("reads every declaration, including the ones outside variables.tf", () => {
		const vars = read();
		expect(vars.size).toBe(10);
		// The one that is easiest to lose: a root variable a cloud declares in a feature file. Reading
		// only `variables.tf` would leave it out of the manifest while tf-wiring still counts it as
		// declared, so the two readers would disagree about the same template.
		expect(vars.get("pull_provider")?.path).toBe("fx/connector-providers.tf");
	});

	it("classifies each type expression into the kind a control is picked from", () => {
		const vars = read();
		expect(vars.get("cluster_name")?.kind).toBe("string");
		expect(vars.get("node_count")?.kind).toBe("number");
		expect(vars.get("enable_logs")?.kind).toBe("bool");
		expect(vars.get("allowed_cidr_blocks")?.kind).toBe("list");
		expect(vars.get("labels")?.kind).toBe("map");
		expect(vars.get("scaling")?.kind).toBe("object");
		// `list(object({…}))` is a LIST — what a caller passes is a list, and the object below it is
		// the shape of one entry, carried separately.
		expect(vars.get("buckets")?.kind).toBe("list");
	});

	it("tells a required variable from a defaulted one, in both directions", () => {
		const vars = read();
		expect(vars.get("cluster_name")?.required).toBe(true);
		expect(vars.get("admin_password")?.required).toBe(true);
		expect(vars.get("node_count")?.required).toBe(false);
		expect(vars.get("allowed_cidr_blocks")?.required).toBe(false);
	});

	it("parses each default as a VALUE, not as its own source text", () => {
		const vars = read();
		expect(vars.get("node_count")?.default).toBe(3);
		expect(vars.get("enable_logs")?.default).toBe(true);
		expect(vars.get("allowed_cidr_blocks")?.default).toEqual([]);
		expect(vars.get("labels")?.default).toEqual({ team: "platform" });
		expect(vars.get("scaling")?.default).toEqual({ min: 1, max: 4 });
		// A variable with no default carries no `default` key at all — `undefined` and "defaults to
		// undefined" are different statements, and a UI reads them differently.
		expect("default" in (vars.get("cluster_name") ?? {})).toBe(false);
	});

	it("carries the description and the sensitive flag", () => {
		const vars = read();
		expect(vars.get("node_count")?.description).toBe("How many workers.");
		// No description is an EMPTY one, never undefined: a control renders the string.
		expect(vars.get("enable_logs")?.description).toBe("");
		expect(vars.get("admin_password")?.sensitive).toBe(true);
		expect(vars.get("cluster_name")?.sensitive).toBe(false);
	});

	it("points at the file and line the declaration is on", () => {
		const vars = read();
		expect(vars.get("cluster_name")?.path).toBe("fx/variables.tf");
		expect(vars.get("cluster_name")?.line).toBe(2);
	});
});

describe("objectAttributeTypesIn", () => {
	it("reads the outermost object's attributes, unwrapping optional() into a default", () => {
		const attrs = objectAttributeTypesIn(read().get("buckets")?.typeExpr ?? "");
		expect([...attrs.keys()].sort()).toEqual(["cors", "name", "versioning"]);
		expect(attrs.get("name")?.required).toBe(true);
		expect(attrs.get("versioning")?.required).toBe(false);
		expect(attrs.get("versioning")?.kind).toBe("bool");
		expect(attrs.get("versioning")?.default).toBe(false);
		expect(attrs.get("cors")?.kind).toBe("list");
	});

	it("reports NO attributes for list(any) — the template makes no statement about its keys", () => {
		// The direction that matters: reporting an attribute here would offer a user a key the
		// template never promised, and reporting one for a shape that HAS keys would hide the rest.
		expect(objectAttributeTypesIn(read().get("opaque")?.typeExpr ?? "").size).toBe(0);
	});
});

describe("parseHclLiteral", () => {
	it("reads the literals a template writes", () => {
		expect(parseHclLiteral('"fsn1"')).toBe("fsn1");
		expect(parseHclLiteral("42")).toBe(42);
		expect(parseHclLiteral("-1.5")).toBe(-1.5);
		expect(parseHclLiteral("false")).toBe(false);
		expect(parseHclLiteral("null")).toBeNull();
		expect(parseHclLiteral('["a", "b"]')).toEqual(["a", "b"]);
		expect(parseHclLiteral('{ a = 1, b = "x" }')).toEqual({ a: 1, b: "x" });
	});

	it("refuses an EXPRESSION rather than returning its source text", () => {
		// The whole reason this returns undefined instead of a string: `default = local.region`
		// rendered into a field reads as the literal text "local.region", which a user then saves.
		expect(parseHclLiteral("local.region")).toBeUndefined();
		expect(parseHclLiteral('"${var.region}-suffix"')).toBeUndefined();
		expect(parseHclLiteral("var.enabled ? 1 : 0")).toBeUndefined();
		expect(parseHclLiteral("[for x in var.xs : x]")).toBeUndefined();
	});
});

describe("kindOf", () => {
	it("treats an absent type and an explicit any as the same free-form statement", () => {
		expect(kindOf("")).toBe("any");
		expect(kindOf("any")).toBe("any");
	});
});
