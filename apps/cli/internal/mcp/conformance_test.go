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
	"reflect"
	"strings"
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

// envelopeNaming is the per-request envelope with its protocol-version key set to version, a raw
// JSON value so a test can also name a non-string.
func envelopeNaming(version string) string {
	return strings.Replace(modernEnvelope, `"2026-07-28"`, version, 1)
}

// A request whose envelope names a revision this server does not speak is refused before its method
// runs, with the refusal the MCP SDK and the remote route answer: -32022, "Unsupported protocol
// version: <requested>", and data naming the modern revisions served and the one requested. A
// 2025 revision in the envelope is refused too: the envelope is a 2026-07-28 mechanism.
func TestConformance_AnEnvelopeNamingAnUnsupportedRevisionIsRefusedWithTheSupportedList(t *testing.T) {
	for _, requested := range []string{"2099-01-01", "2025-06-18"} {
		t.Run(requested, func(t *testing.T) {
			runner := conformanceRunner()
			meta := envelopeNaming(fmt.Sprintf("%q", requested))
			got := session(t, Options{Runner: runner},
				`{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{`+meta+`}}`,
				`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{`+meta+`}}`,
				`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"project_list","arguments":{},`+meta+`}}`,
				`{"jsonrpc":"2.0","id":4,"method":"ping","params":{`+meta+`}}`,
			)
			want := map[string]any{
				"code":    float64(-32022),
				"message": "Unsupported protocol version: " + requested,
				"data":    map[string]any{"supported": []any{"2026-07-28"}, "requested": requested},
			}
			for _, id := range []string{"1", "2", "3", "4"} {
				if got[id]["result"] != nil || !reflect.DeepEqual(got[id]["error"], want) {
					t.Errorf("request %s answered %v, want error %v", id, got[id], want)
				}
			}
			if len(runner.argvs) != 0 {
				t.Errorf("a refused tools/call ran %v", runner.argvs)
			}
		})
	}
}

// A malformed envelope is refused -32602 before its revision is read, naming the key and the
// problem, as the SDK does: a version that is not a string, or no client capabilities.
func TestConformance_AMalformedEnvelopeIsRefusedNamingTheKey(t *testing.T) {
	noCapabilities := `"_meta":{"io.modelcontextprotocol/protocolVersion":"2099-01-01"}`
	got := session(t, Options{Runner: conformanceRunner()},
		`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{`+envelopeNaming(`7`)+`}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{`+noCapabilities+`}}`,
	)
	for id, key := range map[string]string{
		"1": "io.modelcontextprotocol/protocolVersion",
		"2": "io.modelcontextprotocol/clientCapabilities",
	} {
		e, _ := got[id]["error"].(map[string]any)
		data, _ := e["data"].(map[string]any)
		envelope, _ := data["envelope"].(map[string]any)
		if e["code"] != float64(codeInvalidParams) || envelope["key"] != key {
			t.Errorf("request %s answered %v, want -32602 naming %s", id, got[id], key)
		}
	}
}

// Every 2026-07-28 result carries what the MCP SDK's encode contract puts on it: `resultType`
// "complete", the server's identity under `_meta`, and on the cacheable methods `ttlMs` 0 and
// `cacheScope` "private". The 2025 revisions' results carry none of it.
func TestConformance_EveryModernResultCarriesTheRevisionsResultMetadata(t *testing.T) {
	got := session(t, Options{Runner: conformanceRunner()},
		`{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{`+modernEnvelope+`}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{`+modernEnvelope+`}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"project_list","arguments":{},`+modernEnvelope+`}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"project_list","arguments":{"nope":1},`+modernEnvelope+`}}`,
		`{"jsonrpc":"2.0","id":5,"method":"ping","params":{`+modernEnvelope+`}}`,
		`{"jsonrpc":"2.0","id":6,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"project_list","arguments":{}}}`,
	)
	serverInfo := map[string]any{"name": "alethia", "title": "Alethia CLI", "version": "test"}
	for _, tc := range []struct {
		id        string
		cacheable bool
	}{{"1", true}, {"2", true}, {"3", false}, {"4", false}, {"5", false}} {
		r := result(t, got[tc.id])
		if r["resultType"] != "complete" {
			t.Errorf("result %s resultType = %v", tc.id, r["resultType"])
		}
		meta, _ := r["_meta"].(map[string]any)
		if !reflect.DeepEqual(meta["io.modelcontextprotocol/serverInfo"], serverInfo) {
			t.Errorf("result %s _meta = %v", tc.id, r["_meta"])
		}
		ttl, hasTTL := r["ttlMs"]
		scope, hasScope := r["cacheScope"]
		if tc.cacheable && (ttl != float64(0) || scope != "private") {
			t.Errorf("cacheable result %s ttlMs = %v, cacheScope = %v", tc.id, ttl, scope)
		}
		if !tc.cacheable && (hasTTL || hasScope) {
			t.Errorf("result %s is not cacheable but carries ttlMs/cacheScope", tc.id)
		}
	}
	if result(t, got["4"])["isError"] != true {
		t.Errorf("a bad argument was not a tool error: %v", got["4"])
	}
	for _, id := range []string{"6", "7"} {
		r := result(t, got[id])
		if _, ok := r["resultType"]; ok {
			t.Errorf("2025-era result %s carries resultType", id)
		}
		if _, ok := r["_meta"]; ok {
			t.Errorf("2025-era result %s carries _meta", id)
		}
	}
}
