// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A step-level `env:` key SHADOWS a value an earlier step wrote to $GITHUB_ENV.
//
// That is GitHub Actions' precedence, and it is silent: the step-level entry is evaluated at the
// step, and if it renders empty the process sees the EMPTY string, not the value the earlier step
// exported. Nothing warns and nothing goes red at the point of the defect.
//
// It cost the first-ever `cli-demo` run (#5055, run 36054781150). The build step wrote
// `ALETHIA_E2E_CLI_BIN=$RUNNER_TEMP/alethia` to $GITHUB_ENV; the T2 step then declared
// `ALETHIA_E2E_CLI_BIN: ${{ vars.E2E_CLI_BIN }}` in its own `env:`, the variable was unset, and
// the harness fell back to a bare `alethia` and refused the run in 0.00s — after ten minutes of
// console build. Every step AFTER T2, which carries no such entry, shows the built path in the
// same log, which is what makes the precedence unambiguous.
//
// The escape that keeps a deliberate override possible is to read the exported value back:
// `${{ vars.X || env.X }}`. An entry that mentions `env.<KEY>` is therefore not a shadow.
package e2e

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// ghWorkflow is the slice of a workflow file this guard reads: each job's ordered steps.
type ghWorkflow struct {
	Jobs map[string]struct {
		Steps []ghStep `yaml:"steps"`
	} `yaml:"jobs"`
}

// ghStep is one step's name, its step-level env block, and its shell script.
type ghStep struct {
	Name string            `yaml:"name"`
	ID   string            `yaml:"id"`
	Uses string            `yaml:"uses"`
	Env  map[string]string `yaml:"env"`
	Run  string            `yaml:"run"`
}

// label names a step for a finding: its name, else its id, else the action it uses.
func (s ghStep) label() string {
	switch {
	case s.Name != "":
		return s.Name
	case s.ID != "":
		return s.ID
	default:
		return s.Uses
	}
}

var (
	// ghEnvRedirect matches an append to $GITHUB_ENV in any of the quotings used in this repo.
	ghEnvRedirect = regexp.MustCompile(`>>\s*"?\$\{?GITHUB_ENV\}?"?`)
	// ghEnvAssign matches the NAME= an echo/printf line emits.
	ghEnvAssign = regexp.MustCompile(`(?:echo|printf)\s+(?:'[^']*'\s+)?["']?([A-Za-z_][A-Za-z0-9_]*)=`)
)

// githubEnvWrites returns the variable NAMES a run script appends to $GITHUB_ENV.
//
// Two shapes are read: a single line that both emits `NAME=` and redirects, and a `{ … }` group
// whose closing brace redirects. Stated boundary: a name produced at runtime — `printf "$var"` or
// a program's stdout (`go run ./cmd/gcpzone >> "$GITHUB_ENV"`) — is not knowable from the text and
// is not reported. That under-reports; it cannot manufacture a finding.
func githubEnvWrites(run string) []string {
	var names []string
	lines := strings.Split(run, "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") {
			continue
		}
		if trimmed == "{" {
			// Find the closing brace; the group writes to $GITHUB_ENV only if IT redirects.
			j := i + 1
			for ; j < len(lines); j++ {
				if strings.HasPrefix(strings.TrimSpace(lines[j]), "}") {
					break
				}
			}
			if j < len(lines) && ghEnvRedirect.MatchString(lines[j]) {
				for _, inner := range lines[i+1 : j] {
					t := strings.TrimSpace(inner)
					if strings.HasPrefix(t, "#") {
						continue
					}
					if m := ghEnvAssign.FindStringSubmatch(t); m != nil {
						names = append(names, m[1])
					}
				}
			}
			i = j
			continue
		}
		if ghEnvRedirect.MatchString(line) {
			if m := ghEnvAssign.FindStringSubmatch(trimmed); m != nil {
				names = append(names, m[1])
			}
		}
	}
	return names
}

// envShadowFindings reports every step-level env key that shadows a name an EARLIER step of the
// same job wrote to $GITHUB_ENV, unless the entry reads the exported value back via `env.<KEY>`.
func envShadowFindings(wf ghWorkflow) (findings []string, writes int) {
	jobs := make([]string, 0, len(wf.Jobs))
	for j := range wf.Jobs {
		jobs = append(jobs, j)
	}
	sort.Strings(jobs)
	for _, job := range jobs {
		writtenBy := map[string]string{}
		for _, step := range wf.Jobs[job].Steps {
			keys := make([]string, 0, len(step.Env))
			for k := range step.Env {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				writer, ok := writtenBy[k]
				if !ok || strings.Contains(step.Env[k], "env."+k) {
					continue
				}
				findings = append(findings, fmt.Sprintf(
					"job %q, step %q: `env: %s: %s` shadows the value step %q wrote to $GITHUB_ENV — "+
						"if it renders empty, the process sees EMPTY. Drop the entry, or read the export "+
						"back with `${{ … || env.%s }}`.",
					job, step.label(), k, step.Env[k], writer, k))
			}
			for _, n := range githubEnvWrites(step.Run) {
				writtenBy[n] = step.label()
				writes++
			}
		}
	}
	return findings, writes
}

func TestGithubEnvWritesReadsBothShapes(t *testing.T) {
	run := strings.Join([]string{
		`echo "A=1" >> "$GITHUB_ENV"`,
		`echo B=2 >>$GITHUB_ENV`,
		`# echo "COMMENTED=1" >> "$GITHUB_ENV"`,
		`echo "NOT_WRITTEN=1"`,
		`{`,
		`  echo "C=3"`,
		`  # a comment inside the group`,
		`  printf 'D=%s\n' "$x"`,
		`} >> "$GITHUB_ENV"`,
		`{`,
		`  echo "E=5"`,
		`} > somefile`,
		`printf '%s\n' "$dynamic" >> "$GITHUB_ENV"`,
	}, "\n")
	got := githubEnvWrites(run)
	want := []string{"A", "B", "C", "D"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("githubEnvWrites = %v, want %v", got, want)
	}
}

func TestEnvShadowFindingsFixture(t *testing.T) {
	wf := ghWorkflow{Jobs: map[string]struct {
		Steps []ghStep `yaml:"steps"`
	}{
		"j": {Steps: []ghStep{
			{Name: "early reader", Env: map[string]string{"BIN": "${{ vars.BIN }}"}},
			{Name: "build", Run: `echo "BIN=/tmp/alethia" >> "$GITHUB_ENV"`},
			{Name: "shadows", Env: map[string]string{"BIN": "${{ vars.BIN }}"}},
			{Name: "reads back", Env: map[string]string{"BIN": "${{ vars.BIN || env.BIN }}"}},
			{Name: "inherits", Run: "true"},
		}},
	}}
	findings, writes := envShadowFindings(wf)
	if writes != 1 {
		t.Fatalf("writes = %d, want 1", writes)
	}
	// Only the step AFTER the writer that does not read the export back is a shadow; the step
	// before the writer is not, because nothing had been exported yet.
	if len(findings) != 1 || !strings.Contains(findings[0], `step "shadows"`) {
		t.Fatalf("findings = %v, want exactly one, on step \"shadows\"", findings)
	}
}

// TestWorkflowStepEnvDoesNotShadowGithubEnv runs the guard over every workflow in the repo.
func TestWorkflowStepEnvDoesNotShadowGithubEnv(t *testing.T) {
	dir := filepath.Join(e2ePackageDir(t), "..", "..", ".github", "workflows")
	files, err := filepath.Glob(filepath.Join(dir, "*.yml"))
	if err != nil {
		t.Fatalf("glob workflows: %v", err)
	}
	if len(files) == 0 {
		t.Fatalf("no workflows under %s — this guard would report green having read nothing", dir)
	}
	totalWrites := 0
	var all []string
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		var wf ghWorkflow
		if err := yaml.Unmarshal(raw, &wf); err != nil {
			t.Fatalf("parse %s: %v", f, err)
		}
		findings, writes := envShadowFindings(wf)
		totalWrites += writes
		for _, fnd := range findings {
			all = append(all, filepath.Base(f)+": "+fnd)
		}
	}
	// Non-vacuity: e2e-nightly.yml alone exports well over a dozen names, the CLI binary among
	// them. A parser that silently stopped reading them would otherwise report green.
	if totalWrites < 15 {
		t.Fatalf("read only %d $GITHUB_ENV writes across %d workflows — the extractor has stopped "+
			"seeing them, and a green result would mean nothing", totalWrites, len(files))
	}
	for _, fnd := range all {
		t.Error(fnd)
	}
}
