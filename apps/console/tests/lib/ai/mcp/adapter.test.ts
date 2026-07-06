// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the MCP adapter (registerAiToolsOnMcp): the only boundary is the
// MCP server, faked with a registerTool spy. Everything else is REAL — zod schema introspection,
// the stringify helper, and the registered async callback (we invoke it and assert what it does).
// We assert: which tools get registered (execute gate), the description/inputSchema-shape
// transform, that the callback calls the real tool's execute() with the bound options, the
// success/error content shapes, and the stringify branches (string passthrough, bigint, fallback).

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolSet } from "ai";

import { registerAiToolsOnMcp } from "@/lib/ai/mcp/adapter";

/** A captured registerTool() call: the registered name, config, and async callback. */
interface Registration {
	name: string;
	config: { description?: string; inputSchema: unknown };
	cb: (args: unknown) => Promise<{
		isError?: boolean;
		content: { type: string; text: string }[];
	}>;
}

/** Builds a fake McpServer whose registerTool records every registration for assertion. */
function fakeServer() {
	const registrations: Registration[] = [];
	const registerTool = vi.fn(
		(name: string, config: Registration["config"], cb: Registration["cb"]) => {
			registrations.push({ name, config, cb });
		},
	);
	return { server: { registerTool } as unknown as McpServer, registrations, registerTool };
}

describe("registerAiToolsOnMcp", () => {
	it("registers an executable tool with its description and the raw zod object shape", () => {
		const { server, registrations, registerTool } = fakeServer();
		const inputSchema = z.object({ id: z.string(), count: z.number() });
		const tools = {
			get_thing: { description: "Get a thing", inputSchema, execute: vi.fn() },
		} as unknown as ToolSet;

		registerAiToolsOnMcp(server, tools);

		expect(registerTool).toHaveBeenCalledTimes(1);
		const reg = registrations[0];
		expect(reg.name).toBe("get_thing");
		expect(reg.config.description).toBe("Get a thing");
		// The transform passes the ZodRawShape (the .shape), not the ZodObject itself.
		expect(reg.config.inputSchema).toBe(inputSchema.shape);
		expect(Object.keys(reg.config.inputSchema as object)).toEqual(["id", "count"]);
	});

	it("skips tools whose execute is not a function", () => {
		const { server, registerTool } = fakeServer();
		const tools = {
			no_exec: { description: "x", inputSchema: z.object({}) },
			has_exec: { description: "y", inputSchema: z.object({}), execute: vi.fn() },
		} as unknown as ToolSet;

		registerAiToolsOnMcp(server, tools);

		expect(registerTool).toHaveBeenCalledTimes(1);
		expect(registerTool).toHaveBeenCalledWith(
			"has_exec",
			expect.anything(),
			expect.any(Function),
		);
	});

	it("falls back to the tool name as description when none is provided", () => {
		const { server, registrations } = fakeServer();
		const tools = {
			unnamed: { inputSchema: z.object({}), execute: vi.fn() },
		} as unknown as ToolSet;

		registerAiToolsOnMcp(server, tools);

		expect(registrations[0].config.description).toBe("unnamed");
	});

	it("uses an empty shape when the inputSchema is not a ZodObject", () => {
		const { server, registrations } = fakeServer();
		const tools = {
			scalar: { inputSchema: z.string(), execute: vi.fn() },
		} as unknown as ToolSet;

		registerAiToolsOnMcp(server, tools);

		expect(registrations[0].config.inputSchema).toEqual({});
	});

	it("callback invokes execute with the args and bound options, wrapping the result as text", async () => {
		const { server, registrations } = fakeServer();
		const execute = vi.fn().mockResolvedValue({ ok: true, n: 2 });
		const tools = {
			my_tool: { description: "d", inputSchema: z.object({ a: z.string() }), execute },
		} as unknown as ToolSet;

		registerAiToolsOnMcp(server, tools);
		const res = await registrations[0].cb({ a: "hello" });

		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledWith(
			{ a: "hello" },
			{ toolCallId: "mcp_my_tool", messages: [] },
		);
		expect(res).toEqual({
			content: [{ type: "text", text: JSON.stringify({ ok: true, n: 2 }, null, 2) }],
		});
	});

	it("defaults undefined args to an empty object when calling execute", async () => {
		const { server, registrations } = fakeServer();
		const execute = vi.fn().mockResolvedValue("done");
		const tools = {
			t: { inputSchema: z.object({}), execute },
		} as unknown as ToolSet;

		registerAiToolsOnMcp(server, tools);
		await registrations[0].cb(undefined);

		expect(execute).toHaveBeenCalledWith({}, { toolCallId: "mcp_t", messages: [] });
	});

	it("passes a string result through stringify verbatim (no JSON quoting)", async () => {
		const { server, registrations } = fakeServer();
		const tools = {
			t: { inputSchema: z.object({}), execute: vi.fn().mockResolvedValue("plain text") },
		} as unknown as ToolSet;

		registerAiToolsOnMcp(server, tools);
		const res = await registrations[0].cb({});

		expect(res).toEqual({ content: [{ type: "text", text: "plain text" }] });
	});

	it("serializes bigint values as strings rather than throwing", async () => {
		const { server, registrations } = fakeServer();
		const tools = {
			t: { inputSchema: z.object({}), execute: vi.fn().mockResolvedValue({ big: BigInt("9007199254740993") }) },
		} as unknown as ToolSet;

		registerAiToolsOnMcp(server, tools);
		const res = await registrations[0].cb({});

		expect(res.content[0].text).toBe('{\n  "big": "9007199254740993"\n}');
	});

	it("falls back to String(value) when the result cannot be JSON-serialized (cycle)", async () => {
		const { server, registrations } = fakeServer();
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const tools = {
			t: { inputSchema: z.object({}), execute: vi.fn().mockResolvedValue(cyclic) },
		} as unknown as ToolSet;

		registerAiToolsOnMcp(server, tools);
		const res = await registrations[0].cb({});

		expect(res).toEqual({ content: [{ type: "text", text: "[object Object]" }] });
	});

	it("returns an MCP tool error (isError) with the Error message when execute throws", async () => {
		const { server, registrations } = fakeServer();
		const tools = {
			t: {
				inputSchema: z.object({}),
				execute: vi.fn().mockRejectedValue(new Error("Forbidden: ai:budget")),
			},
		} as unknown as ToolSet;

		registerAiToolsOnMcp(server, tools);
		const res = await registrations[0].cb({});

		expect(res).toEqual({
			isError: true,
			content: [{ type: "text", text: "Forbidden: ai:budget" }],
		});
	});

	it("stringifies a non-Error thrown value in the error branch", async () => {
		const { server, registrations } = fakeServer();
		const tools = {
			t: { inputSchema: z.object({}), execute: vi.fn().mockRejectedValue("boom-string") },
		} as unknown as ToolSet;

		registerAiToolsOnMcp(server, tools);
		const res = await registrations[0].cb({});

		expect(res).toEqual({ isError: true, content: [{ type: "text", text: "boom-string" }] });
	});

	it("registers each executable tool across a multi-tool set", () => {
		const { server, registrations } = fakeServer();
		const tools = {
			a: { inputSchema: z.object({}), execute: vi.fn() },
			b: { inputSchema: z.object({}), execute: vi.fn() },
			c: { inputSchema: z.object({}) }, // no execute → skipped
		} as unknown as ToolSet;

		registerAiToolsOnMcp(server, tools);

		expect(registrations.map((r) => r.name)).toEqual(["a", "b"]);
	});
});
