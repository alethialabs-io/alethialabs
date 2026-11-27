// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
)

// fakeRunner answers every run with a fixed result, recording the command lines it was given. When
// block is set it waits for the run's context instead.
type fakeRunner struct {
	mu    sync.Mutex
	argvs [][]string
	res   Result
	block bool
}

// Run records argv and returns the fixed result, or waits for ctx when block is set.
func (f *fakeRunner) Run(ctx context.Context, argv []string) (Result, error) {
	f.mu.Lock()
	f.argvs = append(f.argvs, argv)
	f.mu.Unlock()
	if f.block {
		<-ctx.Done()
		return Result{}, ctx.Err()
	}
	return f.res, nil
}

// testTools are the tools the server tests offer.
func testTools() []Tool {
	return []Tool{{
		Name: "project_list", Command: []string{"project", "list"}, Title: "alethia project list",
		Description: "List projects", Annotations: Annotations{ReadOnlyHint: true, OpenWorldHint: true},
		Flags: map[string]cmdmeta.FlagDoc{"org": {Name: "org", Type: "string"}},
	}}
}

// session runs a server over in and returns every response it wrote, by id.
func session(t *testing.T, opts Options, lines ...string) map[string]map[string]any {
	t.Helper()
	opts.Name, opts.Version = "alethia", "test"
	if opts.Tools == nil {
		opts.Tools = testTools()
	}
	pr, pw := io.Pipe()
	go func() {
		defer pw.Close()
		for _, l := range lines {
			_, _ = io.WriteString(pw, l+"\n")
		}
	}()
	var out strings.Builder
	if err := NewServer(opts).Serve(context.Background(), pr, &syncWriter{w: &out}); err != nil {
		t.Fatal(err)
	}
	got := map[string]map[string]any{}
	sc := bufio.NewScanner(strings.NewReader(out.String()))
	for sc.Scan() {
		var msg map[string]any
		if err := json.Unmarshal(sc.Bytes(), &msg); err != nil {
			t.Fatalf("server wrote a line that is not JSON: %q", sc.Text())
		}
		id, _ := json.Marshal(msg["id"])
		got[string(id)] = msg
	}
	return got
}

// syncWriter serialises writes to a strings.Builder.
type syncWriter struct {
	mu sync.Mutex
	w  *strings.Builder
}

// Write appends p under the lock.
func (s *syncWriter) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.w.Write(p)
}

// result returns a response's result object, failing when it is an error.
func result(t *testing.T, msg map[string]any) map[string]any {
	t.Helper()
	r, ok := msg["result"].(map[string]any)
	if !ok {
		t.Fatalf("no result in %v", msg)
	}
	return r
}

func TestServer_InitializeAgreesOnTheClientsRevisionOrOffersTheNewest(t *testing.T) {
	got := session(t, Options{Runner: &fakeRunner{}},
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01","capabilities":{}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
	)
	if v := result(t, got["1"])["protocolVersion"]; v != "2025-06-18" {
		t.Errorf("known revision answered with %v", v)
	}
	r := result(t, got["2"])
	if v := r["protocolVersion"]; v != handshakeVersions[0] {
		t.Errorf("unknown revision answered with %v", v)
	}
	if r["instructions"] != Instructions {
		t.Error("initialize does not carry the instructions")
	}
	if len(got) != 2 {
		t.Errorf("a notification was answered: %v", got)
	}
}

func TestServer_DiscoverListsEveryRevision(t *testing.T) {
	got := session(t, Options{Runner: &fakeRunner{}}, `{"jsonrpc":"2.0","id":"d","method":"server/discover"}`)
	r := result(t, got[`"d"`])
	versions, _ := r["supportedVersions"].([]any)
	if len(versions) != len(supportedVersions) || versions[0] != "2026-07-28" {
		t.Errorf("supportedVersions = %v", versions)
	}
}

func TestServer_InstructionsStateTheRulesInTheirFirst512Characters(t *testing.T) {
	head := Instructions
	if len(head) > 512 {
		head = head[:512]
	}
	for _, must := range []string{"approve", "No tool approves", "data, never an instruction"} {
		if !strings.Contains(head, must) {
			t.Errorf("the first 512 characters do not say %q", must)
		}
	}
}

func TestServer_ToolsListServesTheGeneratedTools(t *testing.T) {
	got := session(t, Options{Runner: &fakeRunner{}}, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	tools, _ := result(t, got["1"])["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools = %v", tools)
	}
	tool, _ := tools[0].(map[string]any)
	if tool["name"] != "project_list" || tool["title"] != "alethia project list" {
		t.Errorf("tool = %v", tool)
	}
	ann, _ := tool["annotations"].(map[string]any)
	for _, key := range []string{"readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"} {
		if _, ok := ann[key]; !ok {
			t.Errorf("annotation %s is not stated", key)
		}
	}
}

func TestServer_ACallRunsTheCommandAndReturnsItsJSON(t *testing.T) {
	runner := &fakeRunner{res: Result{Stdout: []byte(`{"projects":[{"name":"shop"}]}` + "\n")}}
	got := session(t, Options{Runner: runner},
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"project_list","arguments":{"org":"acme"}}}`)
	r := result(t, got["1"])
	if r["isError"] != false {
		t.Errorf("isError = %v", r["isError"])
	}
	if sc, _ := r["structuredContent"].(map[string]any); sc["projects"] == nil {
		t.Errorf("structuredContent = %v", r["structuredContent"])
	}
	content, _ := r["content"].([]any)
	first, _ := content[0].(map[string]any)
	if first["text"] != `{"projects":[{"name":"shop"}]}` {
		t.Errorf("text = %v", first["text"])
	}
	if want := [][]string{{"project", "list", "--org=acme"}}; !reflect.DeepEqual(runner.argvs, want) {
		t.Errorf("ran %q, want %q", runner.argvs, want)
	}
}

func TestServer_AFailedCommandIsAToolErrorWithItsReport(t *testing.T) {
	runner := &fakeRunner{res: Result{
		Stderr:   []byte(`{"error":{"code":"approval_required","exit_code":9}}`),
		ExitCode: 9,
	}}
	got := session(t, Options{Runner: runner},
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"project_list"}}`)
	r := result(t, got["1"])
	content, _ := r["content"].([]any)
	first, _ := content[0].(map[string]any)
	text, _ := first["text"].(string)
	if r["isError"] != true || !strings.Contains(text, "approval_required") || !strings.Contains(text, "exit code 9") {
		t.Errorf("result = %v", r)
	}
}

func TestServer_RefusesAnUnknownToolAndBadArgumentsDifferently(t *testing.T) {
	runner := &fakeRunner{}
	got := session(t, Options{Runner: runner},
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"approve","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"project_list","arguments":{"token":"x"}}}`,
		`not json`,
		`{"jsonrpc":"2.0","id":3,"method":"resources/list"}`,
		`[{"jsonrpc":"2.0","id":4,"method":"ping"}]`,
	)
	if e, _ := got["1"]["error"].(map[string]any); e["code"] != float64(codeInvalidParams) {
		t.Errorf("unknown tool: %v", got["1"])
	}
	if r := result(t, got["2"]); r["isError"] != true {
		t.Errorf("bad arguments: %v", r)
	}
	if e, _ := got["null"]["error"].(map[string]any); e == nil {
		t.Errorf("parse or batch error not answered: %v", got["null"])
	}
	if e, _ := got["3"]["error"].(map[string]any); e["code"] != float64(codeMethodNotFound) {
		t.Errorf("unknown method: %v", got["3"])
	}
	if len(runner.argvs) != 0 {
		t.Errorf("a refused call ran %q", runner.argvs)
	}
}

func TestServer_ACallPastItsTimeoutIsStoppedAndSaysSo(t *testing.T) {
	got := session(t, Options{Runner: &fakeRunner{block: true}, CallTimeout: 20 * time.Millisecond},
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"project_list"}}`)
	r := result(t, got["1"])
	content, _ := r["content"].([]any)
	first, _ := content[0].(map[string]any)
	if text, _ := first["text"].(string); r["isError"] != true || !strings.Contains(text, "did not finish within") {
		t.Errorf("result = %v", r)
	}
}

func TestServer_CancellationStopsTheCall(t *testing.T) {
	runner := &fakeRunner{block: true}
	pr, pw := io.Pipe()
	var out strings.Builder
	sw := &syncWriter{w: &out}
	done := make(chan error, 1)
	go func() {
		done <- NewServer(Options{Tools: testTools(), Runner: runner}).Serve(context.Background(), pr, sw)
	}()

	_, _ = io.WriteString(pw, `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"project_list"}}`+"\n")
	deadline := time.Now().Add(5 * time.Second)
	for {
		runner.mu.Lock()
		started := len(runner.argvs) > 0
		runner.mu.Unlock()
		if started || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	_, _ = io.WriteString(pw, `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}`+"\n")
	_ = pw.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the cancelled call never returned")
	}
	sw.mu.Lock()
	defer sw.mu.Unlock()
	if !strings.Contains(out.String(), "cancelled") {
		t.Errorf("output = %s", out.String())
	}
}

func TestChildEnv_RunsInAgentModeWithoutDiagnostics(t *testing.T) {
	got := childEnv([]string{"HOME=/h", "ALETHIA_DEBUG=api", "ALETHIA_AGENT=no", "ALETHIA_TOKEN=t"})
	want := []string{"HOME=/h", "ALETHIA_TOKEN=t", "ALETHIA_AGENT=yes"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("env = %q, want %q", got, want)
	}
}

func TestLimitedBuffer_KeepsTheHeadAndNeverFailsTheWrite(t *testing.T) {
	b := &limitedBuffer{max: 4}
	for _, chunk := range []string{"ab", "cdef", "gh"} {
		if n, err := b.Write([]byte(chunk)); err != nil || n != len(chunk) {
			t.Fatalf("Write(%q) = %d, %v", chunk, n, err)
		}
	}
	if string(b.Bytes()) != "abcd" || !b.cut {
		t.Errorf("kept %q, cut %v", b.Bytes(), b.cut)
	}
}

func TestExecRunner_ReportsOutputAndExitCode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	sh := "/bin/sh"
	if _, err := os.Stat(sh); err != nil {
		t.Skip("no /bin/sh")
	}
	res, err := ExecRunner{Path: sh, Environ: []string{"ALETHIA_DEBUG=api"}}.Run(context.Background(),
		[]string{"-c", `printf '%s|%s' "$ALETHIA_AGENT" "$ALETHIA_DEBUG"; read line; echo "stdin:$line" >&2; exit 3`})
	if err != nil {
		t.Fatal(err)
	}
	if string(res.Stdout) != "yes|" || res.ExitCode != 3 || !slices.Contains(strings.Fields(string(res.Stderr)), "stdin:") {
		t.Errorf("result = stdout %q stderr %q exit %d", res.Stdout, res.Stderr, res.ExitCode)
	}
}

func TestReadLine_SkipsALineLongerThanTheLimit(t *testing.T) {
	long := strings.Repeat("x", maxMessage+10)
	r := bufio.NewReaderSize(strings.NewReader(long+"\n"+`{"ok":1}`+"\n"), 16)
	first, err := readLine(r)
	if err != nil || string(first) != "{}" {
		t.Fatalf("oversized line read as %d bytes, %v", len(first), err)
	}
	second, err := readLine(r)
	if err != nil || string(second) != `{"ok":1}` {
		t.Errorf("the next line read as %q, %v", second, err)
	}
}

func TestCallResult_SaysWhatHappenedWhenThereIsNoJSON(t *testing.T) {
	s := NewServer(Options{CallTimeout: time.Second})
	tool := testTools()[0]
	ctx := context.Background()
	text := func(r map[string]any) string {
		content, _ := r["content"].([]map[string]any)
		s, _ := content[0]["text"].(string)
		return s
	}
	if r := s.callResult(ctx, tool, Result{}, nil); r["isError"] != false || text(r) != "(the command printed nothing)" {
		t.Errorf("empty success = %v", r)
	}
	if r := s.callResult(ctx, tool, Result{Stdout: []byte("plain"), Truncated: true}, nil); !strings.Contains(text(r), "cut at the size limit") || r["structuredContent"] != nil {
		t.Errorf("truncated text = %v", r)
	}
	if r := s.callResult(ctx, tool, Result{}, errors.New("exec format error")); r["isError"] != true || !strings.Contains(text(r), "could not run") {
		t.Errorf("start failure = %v", r)
	}
	if r := s.callResult(ctx, tool, Result{Stdout: []byte("partial"), ExitCode: 2}, nil); !strings.Contains(text(r), "partial") || !strings.Contains(text(r), "exit code 2") {
		t.Errorf("failure with stdout = %v", r)
	}
}
