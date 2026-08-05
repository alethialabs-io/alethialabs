// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The read-back and prune paths in this package all shell out to `kubectl` through
// utils.ExecuteCommand / ExecuteCommandWithOutput (`bash -c "kubectl …"`). To exercise them
// deterministically — no cluster, no network — these tests put a recording `kubectl` stub first on
// PATH. The stub answers a canned stdout per matched argument substring and records every
// invocation, so a test can assert BOTH what the function parsed and which commands it issued.

// stubRule is one canned kubectl answer: when the joined argument string contains Match, the stub
// writes Stdout and exits with Exit.
type stubRule struct {
	Match  string
	Stdout string
	Exit   int
}

// kubectlStub is a recording `kubectl` on PATH for the lifetime of one test.
type kubectlStub struct {
	dir     string
	logPath string
}

// newKubectlStub installs a `kubectl` shim first on PATH. Rules are matched in order against the
// joined arguments; an unmatched call succeeds with empty stdout unless defaultExit is non-zero.
func newKubectlStub(t *testing.T, defaultExit int, rules ...stubRule) *kubectlStub {
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(dir, "calls.log")

	var b strings.Builder
	b.WriteString("#!/bin/sh\n")
	fmt.Fprintf(&b, "printf '%%s\\n' \"$*\" >> %s\n", shellSingleQuote(logPath))
	if len(rules) > 0 {
		b.WriteString("case \"$*\" in\n")
		for i, r := range rules {
			body := filepath.Join(dir, fmt.Sprintf("stdout-%d", i))
			if err := os.WriteFile(body, []byte(r.Stdout), 0o600); err != nil {
				t.Fatalf("write stub body: %v", err)
			}
			fmt.Fprintf(&b, "  *%s*) cat %s; exit %d;;\n",
				shellSingleQuote(r.Match), shellSingleQuote(body), r.Exit)
		}
		b.WriteString("esac\n")
	}
	fmt.Fprintf(&b, "exit %d\n", defaultExit)

	script := filepath.Join(dir, "kubectl")
	if err := os.WriteFile(script, []byte(b.String()), 0o755); err != nil {
		t.Fatalf("write kubectl stub: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return &kubectlStub{dir: dir, logPath: logPath}
}

// calls returns every recorded kubectl invocation, in order.
func (s *kubectlStub) calls() []string {
	body, err := os.ReadFile(s.logPath)
	if err != nil {
		return nil
	}
	var out []string
	for _, ln := range strings.Split(strings.TrimRight(string(body), "\n"), "\n") {
		if ln != "" {
			out = append(out, ln)
		}
	}
	return out
}

// calledWith reports whether any recorded invocation contains the given substring.
func (s *kubectlStub) calledWith(want string) bool {
	for _, c := range s.calls() {
		if strings.Contains(c, want) {
			return true
		}
	}
	return false
}

// shellSingleQuote wraps s in single quotes for safe embedding in the generated /bin/sh stub.
func shellSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
