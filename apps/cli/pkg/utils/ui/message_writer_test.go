// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// TestMessageHelpers_WriteToTheWriterTheyAreGiven: the writer-taking forms are the contract, and
// nothing they print may reach stdout on its own.
func TestMessageHelpers_WriteToTheWriterTheyAreGiven(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	prev := os.Stdout
	os.Stdout = w
	t.Cleanup(func() { os.Stdout = prev })

	var b bytes.Buffer
	SuccessTo(&b, "created")
	ErrorTo(&b, "refused")
	WarningTo(&b, "careful")
	InfoTo(&b, "plain")
	MutedTo(&b, "quiet")
	JobQueuedTo(&b, "PLAN", "job_7")

	w.Close()
	leaked, _ := io.ReadAll(r)
	if len(leaked) != 0 {
		t.Errorf("a writer-taking helper also wrote to stdout: %q", leaked)
	}

	got := b.String()
	for _, want := range []string{
		"\n" + SymbolSuccess + " created\n",
		"\n" + SymbolError + " refused\n",
		"\n" + SymbolPoint + " careful\n",
		"plain\n",
		"quiet\n",
		SymbolSuccess + " Queued PLAN job (ID: job_7)\n",
		"Monitor with: alethia jobs logs job_7 --follow\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("the buffer is missing %q:\n%q", want, got)
		}
	}
}

// TestLegacyMessageHelpers_StillPrintOnStdout pins the spellings the unswept commands call: the
// same bytes as the writer form, on stdout.
func TestLegacyMessageHelpers_StillPrintOnStdout(t *testing.T) {
	var want bytes.Buffer
	SuccessTo(&want, "a")
	ErrorTo(&want, "b")
	WarningTo(&want, "c")
	InfoTo(&want, "d")
	MutedTo(&want, "e")
	JobQueuedTo(&want, "DEPLOY", "job_1")

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	prev := os.Stdout
	os.Stdout = w
	t.Cleanup(func() { os.Stdout = prev })

	Success("a")
	Error("b")
	Warning("c")
	Info("d")
	Muted("e")
	JobQueued("DEPLOY", "job_1")

	w.Close()
	got, _ := io.ReadAll(r)
	if string(got) != want.String() {
		t.Errorf("stdout = %q, want %q", got, want.String())
	}
}

// TestDisableColor_RendersEveryStyleAsPlainText forces a colour profile first, so the test fails
// if DisableColor does nothing rather than passing because a test process has no terminal.
func TestDisableColor_RendersEveryStyleAsPlainText(t *testing.T) {
	prev := lipgloss.ColorProfile()
	t.Cleanup(func() { lipgloss.SetColorProfile(prev) })

	lipgloss.SetColorProfile(termenv.TrueColor)
	if styled := SuccessStyle.Render("ok"); !strings.Contains(styled, "\x1b[") {
		t.Fatalf("the control is not styled (%q), so the assertion below would prove nothing", styled)
	}

	DisableColor()

	var b bytes.Buffer
	SuccessTo(&b, "ok")
	ErrorTo(&b, "no")
	MutedTo(&b, "note")
	if strings.Contains(b.String(), "\x1b[") {
		t.Errorf("an escape sequence survived DisableColor: %q", b.String())
	}
	if want := "\n" + SymbolSuccess + " ok\n\n" + SymbolError + " no\nnote\n"; b.String() != want {
		t.Errorf("plain rendering = %q, want %q", b.String(), want)
	}
}

// TestColorDisabledByEnv covers the two requests and the values that are not one.
func TestColorDisabledByEnv(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want bool
	}{
		{"nothing set", nil, false},
		{"NO_COLOR with a value", map[string]string{"NO_COLOR": "1"}, true},
		{"NO_COLOR set to anything", map[string]string{"NO_COLOR": "false"}, true},
		{"NO_COLOR empty", map[string]string{"NO_COLOR": ""}, false},
		{"TERM=dumb", map[string]string{"TERM": "dumb"}, true},
		{"TERM=xterm", map[string]string{"TERM": "xterm"}, false},
		{"both", map[string]string{"NO_COLOR": "1", "TERM": "dumb"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			lookup := func(name string) (string, bool) {
				v, ok := tc.env[name]
				return v, ok
			}
			if got := ColorDisabledByEnv(lookup); got != tc.want {
				t.Errorf("ColorDisabledByEnv = %v, want %v", got, tc.want)
			}
		})
	}
}

// tabularRecord is a single result that can describe itself as rows.
type tabularRecord struct {
	Name string `json:"name"`
}

// Table returns the record as one row.
func (r tabularRecord) Table() TableSpec {
	return TableSpec{Columns: []string{"name"}, Rows: [][]string{{r.Name}}}
}

// TestRenderJSON_IsRendersJSONBranch: one encoder, so a single value and a result set are indented
// alike and both end in a newline.
func TestRenderJSON_IsRendersJSONBranch(t *testing.T) {
	rec := tabularRecord{Name: "web"}

	var direct, viaRender bytes.Buffer
	if err := RenderJSON(&direct, rec); err != nil {
		t.Fatal(err)
	}
	if err := Render(&viaRender, FormatJSON, TableSpec{}, rec); err != nil {
		t.Fatal(err)
	}
	if direct.String() != viaRender.String() {
		t.Errorf("RenderJSON = %q, Render's json branch = %q", direct.String(), viaRender.String())
	}
	if want := "{\n  \"name\": \"web\"\n}\n"; direct.String() != want {
		t.Errorf("RenderJSON = %q, want %q", direct.String(), want)
	}
	var back tabularRecord
	if err := json.Unmarshal(direct.Bytes(), &back); err != nil || back != rec {
		t.Errorf("round-trip = %+v, %v", back, err)
	}

	// A Tabular value supplies its own csv rows.
	var tab Tabular = rec
	var csvOut bytes.Buffer
	if err := Render(&csvOut, FormatCSV, tab.Table(), rec); err != nil || csvOut.String() != "name\nweb\n" {
		t.Errorf("csv = %q, %v", csvOut.String(), err)
	}
}
