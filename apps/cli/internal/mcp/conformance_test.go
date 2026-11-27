// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package mcp

// Conformance of `alethia mcp` (stdio) at the wire, revision by revision (AGT-L6, #6863; spec §4.8).
//
// Each case is the sequence a client speaking that revision sends, written as raw newline-delimited
// JSON-RPC: the 2025 revisions open with `initialize` and `notifications/initialized`; 2026-07-28
// skips the handshake and carries the per-request `_meta` envelope on every request. A pass says "a
// client speaking revision X gets these answers from this server"; it says nothing about any named
// client. docs/agent-compat.md cites these tests by name.

import (
	"fmt"
	"testing"
)

// modernEnvelope is the 2026-07-28 per-request `_meta` envelope a modern client sends.
const modernEnvelope = `"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",` +
	`"io.modelcontextprotocol/clientInfo":{"name":"alethia-conformance","version":"0"},` +
	`"io.modelcontextprotocol/clientCapabilities":{}}`

// conformanceRunner answers every command with one JSON document on stdout.
func conformanceRunner() *fakeRunner {
	return &fakeRunner{res: Result{Stdout: []byte(`{"projects":[]}` + "\n")}}
}

// assertListAndCall checks that response "2" lists project_list with an object input schema and that
// response "3" is its successful call.
func assertListAndCall(t *testing.T, got map[string]map[string]any) {
	t.Helper()
	tools, _ := result(t, got["2"])["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools/list = %v", tools)
	}
	first, _ := tools[0].(map[string]any)
	schema, _ := first["inputSchema"].(map[string]any)
	if first["name"] != "project_list" || schema["type"] != "object" {
		t.Errorf("listed tool = %v", first)
	}
	call := result(t, got["3"])
	if call["isError"] != false || call["structuredContent"] == nil {
		t.Errorf("tools/call = %v", call)
	}
}

func TestConformance_EachHandshakeRevisionServesTheSequence(t *testing.T) {
	for _, version := range []string{"2025-03-26", "2025-06-18", "2025-11-25"} {
		t.Run(version, func(t *testing.T) {
			got := session(t, Options{Runner: conformanceRunner()},
				fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":%q,"capabilities":{},"clientInfo":{"name":"c","version":"0"}}}`, version),
				`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
				`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
				`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"project_list","arguments":{}}}`,
			)
			if v := result(t, got["1"])["protocolVersion"]; v != version {
				t.Errorf("initialize agreed on %v, want %s", v, version)
			}
			if len(got) != 3 {
				t.Errorf("the notification was answered, or a request was not: %v", got)
			}
			assertListAndCall(t, got)
		})
	}
}

// A client that can speak only an older revision is offered the newest handshake revision, which
// the 2025 lifecycle tells it to disconnect from. So 2024 clients are not served.
func TestConformance_A2024RevisionIsOfferedTheNewestHandshakeRevision(t *testing.T) {
	for _, version := range []string{"2024-10-07", "2024-11-05"} {
		t.Run(version, func(t *testing.T) {
			got := session(t, Options{Runner: conformanceRunner()},
				fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":%q,"capabilities":{}}}`, version))
			if v := result(t, got["1"])["protocolVersion"]; v != "2025-11-25" {
				t.Errorf("initialize at %s answered %v, want 2025-11-25", version, v)
			}
		})
	}
}

func TestConformance_TheModernRevisionServesTheSequenceWithoutAHandshake(t *testing.T) {
	got := session(t, Options{Runner: conformanceRunner()},
		`{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{`+modernEnvelope+`}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{`+modernEnvelope+`}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"project_list","arguments":{},`+modernEnvelope+`}}`,
	)
	discover := result(t, got["1"])
	versions, _ := discover["supportedVersions"].([]any)
	if len(versions) == 0 || versions[0] != "2026-07-28" {
		t.Errorf("supportedVersions = %v", versions)
	}
	if discover["instructions"] != Instructions {
		t.Error("server/discover does not carry the instructions")
	}
	assertListAndCall(t, got)
}
