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

func TestRunStagedList(t *testing.T) {
	cid := "comp-1"
	c := &fakeClient{staged: &api.StagedChanges{
		Environment: "production",
		Changes: []api.StagedChange{
			{ComponentType: "database", Op: "create", CreatedAt: "2026-01-01T00:00:00.000Z"},
			{ComponentType: "cache", Op: "update", ComponentID: &cid, CreatedAt: "2026-01-02T00:00:00.000Z"},
		},
	}}
	var buf bytes.Buffer
	if err := runStagedList(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runStagedList: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"database", "create", "cache", "update", "comp-1"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}

func TestRunStagedListJSON(t *testing.T) {
	c := &fakeClient{staged: &api.StagedChanges{Environment: "prod", Changes: []api.StagedChange{{ComponentType: "queue", Op: "delete", CreatedAt: "2026-01-01T00:00:00.000Z"}}}}
	var buf bytes.Buffer
	if err := runStagedList(c, &buf, "json", "proj", ""); err != nil {
		t.Fatalf("runStagedList json: %v", err)
	}
	if !strings.Contains(buf.String(), `"component_type": "queue"`) || !strings.Contains(buf.String(), `"op": "delete"`) {
		t.Errorf("json output unexpected:\n%s", buf.String())
	}
}

func TestRunStagedListEmpty(t *testing.T) {
	c := &fakeClient{staged: &api.StagedChanges{Environment: "prod", Changes: nil}}
	var buf bytes.Buffer
	if err := runStagedList(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runStagedList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No staged changes") {
		t.Errorf("expected empty notice, got: %q", buf.String())
	}
}

func TestRunStagedListError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runStagedList(c, &bytes.Buffer{}, "table", "proj", ""); err == nil {
		t.Error("expected error to propagate")
	}
}
