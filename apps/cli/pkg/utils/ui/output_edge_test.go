// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

// errWriter fails every write, so the csv encoder's error paths are reachable.
type errWriter struct{}

// Write always fails.
func (errWriter) Write(p []byte) (int, error) { return 0, errors.New("disk full") }

// bigCell returns a value large enough to force the csv writer to flush, which
// is what surfaces the underlying writer's error.
func bigCell() string { return strings.Repeat("x", 8192) }

func TestRenderCSVPropagatesWriteErrors(t *testing.T) {
	tests := []struct {
		name string
		spec TableSpec
	}{
		{
			name: "header write fails",
			spec: TableSpec{Columns: []string{bigCell()}},
		},
		{
			name: "row write fails",
			spec: TableSpec{Columns: []string{"A"}, Rows: [][]string{{bigCell()}}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := Render(errWriter{}, FormatCSV, tt.spec, nil); err == nil {
				t.Error("expected the underlying writer's error to propagate")
			}
		})
	}
}

func TestRenderTableWithNoColumnsWritesNothing(t *testing.T) {
	var buf bytes.Buffer
	spec := TableSpec{Rows: [][]string{{"orphan"}}}
	if err := Render(&buf, FormatTable, spec, nil); err != nil {
		t.Fatalf("Render: %v", err)
	}
	if buf.Len() != 0 {
		t.Errorf("a spec with no columns must render nothing, got %q", buf.String())
	}
}

func TestRenderTableRowShorterThanColumns(t *testing.T) {
	var buf bytes.Buffer
	spec := TableSpec{
		Columns: []string{"Name", "Stage", "Region"},
		Rows:    [][]string{{"alpha", "prod", "eu-central-1"}, {"beta"}},
	}
	if err := Render(&buf, FormatTable, spec, nil); err != nil {
		t.Fatalf("Render: %v", err)
	}
	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected a header plus two rows, got %d lines:\n%s", len(lines), buf.String())
	}
	if lines[2] != "beta" {
		t.Errorf("a short row must not be padded past its last cell, got %q", lines[2])
	}
}

func TestRenderCardSkipsRowsWithoutAValue(t *testing.T) {
	var buf bytes.Buffer
	rows := [][]string{{"Status", "FAILED"}, {"separator"}, nil, {"Region", "eu-central-1"}}
	if err := RenderCard(&buf, FormatTable, "job", rows, nil); err != nil {
		t.Fatalf("RenderCard: %v", err)
	}
	out := buf.String()
	if strings.Contains(out, "separator") {
		t.Errorf("a row without a value must be skipped:\n%s", out)
	}
	for _, want := range []string{"Status", "FAILED", "Region", "eu-central-1"} {
		if !strings.Contains(out, want) {
			t.Errorf("card missing %q:\n%s", want, out)
		}
	}
}
