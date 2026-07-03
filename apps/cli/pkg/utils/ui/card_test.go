// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestRenderCardTable(t *testing.T) {
	var buf bytes.Buffer
	rows := [][]string{{"User", "ada@example.com"}, {"Role", "owner"}}
	if err := RenderCard(&buf, FormatTable, "whoami", rows, nil); err != nil {
		t.Fatalf("RenderCard: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"ada@example.com", "owner", "╭", "╰"} {
		if !strings.Contains(out, want) {
			t.Errorf("card missing %q:\n%s", want, out)
		}
	}
}

func TestRenderCardJSON(t *testing.T) {
	var buf bytes.Buffer
	rec := map[string]string{"email": "ada@example.com"}
	if err := RenderCard(&buf, FormatJSON, "whoami", nil, rec); err != nil {
		t.Fatalf("RenderCard json: %v", err)
	}
	var got map[string]string
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if got["email"] != "ada@example.com" {
		t.Errorf("unexpected json: %s", buf.String())
	}
}

func TestRenderCardCSV(t *testing.T) {
	var buf bytes.Buffer
	rows := [][]string{{"User", "ada@example.com"}}
	if err := RenderCard(&buf, FormatCSV, "whoami", rows, nil); err != nil {
		t.Fatalf("RenderCard csv: %v", err)
	}
	if !strings.Contains(buf.String(), "Field,Value") || !strings.Contains(buf.String(), "ada@example.com") {
		t.Errorf("csv card: %q", buf.String())
	}
}
