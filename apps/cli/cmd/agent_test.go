// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func TestRunAgentList(t *testing.T) {
	c := &fakeClient{agents: []api.Agent{
		{ID: "ag-1", Persona: "provisioner", Mission: "keep infra healthy", ToolScope: []string{"plan", "apply"}, MemoryNamespace: "ns/one", Version: 2},
		{ID: "ag-2", Persona: "reviewer", MemoryNamespace: "ns/two", Version: 1},
	}}
	var buf bytes.Buffer
	if err := runAgentList(c, &buf, "table"); err != nil {
		t.Fatalf("runAgentList: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"ag-1", "provisioner", "ns/one", "reviewer"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}

func TestRunAgentListEmpty(t *testing.T) {
	c := &fakeClient{agents: nil}
	var buf bytes.Buffer
	if err := runAgentList(c, &buf, "table"); err != nil {
		t.Fatalf("runAgentList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No agent identities") {
		t.Errorf("expected empty notice, got: %q", buf.String())
	}
}

func TestRunAgentListError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runAgentList(c, &bytes.Buffer{}, "table"); err == nil {
		t.Error("expected error to propagate")
	}
}

func TestRunAgentGet(t *testing.T) {
	c := &fakeClient{agent: &api.Agent{
		ID: "ag-1", Persona: "provisioner", Mission: "keep infra healthy",
		ToolScope: []string{"plan", "apply"}, MemoryNamespace: "ns/one", Version: 3,
	}}
	var buf bytes.Buffer
	if err := runAgentGet(c, &buf, "table", "ag-1"); err != nil {
		t.Fatalf("runAgentGet: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"provisioner", "keep infra healthy", "plan, apply", "ns/one"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
}

func TestRunAgentGetJSON(t *testing.T) {
	c := &fakeClient{agent: &api.Agent{ID: "ag-1", Persona: "provisioner", ToolScope: []string{}}}
	var buf bytes.Buffer
	if err := runAgentGet(c, &buf, "json", "ag-1"); err != nil {
		t.Fatalf("runAgentGet json: %v", err)
	}
	if !strings.Contains(buf.String(), `"persona": "provisioner"`) {
		t.Errorf("json output unexpected:\n%s", buf.String())
	}
}

func TestRunAgentGetError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runAgentGet(c, &bytes.Buffer{}, "table", "ag-1"); err == nil {
		t.Error("expected error to propagate")
	}
}
