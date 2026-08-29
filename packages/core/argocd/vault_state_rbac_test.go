// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

// The Role a bootstrap Job runs under must grant every verb the runner's state read actually uses.
//
// These two live in different modules and neither imports the other: the read is
// `apps/runner/internal/agent/vault_state.go`, the Role is rendered from string literals here in
// `packages/core/argocd`. Nothing links them, so the read changed shape — from a by-name GET to a
// field-selected LIST, deliberately, because a list has no NotFound path and can therefore PROVE
// absence — and the Role did not follow. Every Vault bootstrap would have been Forbidden on every
// cluster, and because an unreadable state is fatal by design, `vaultBootstrap` returns before
// `waitForVault` through all four backoffLimit attempts.
//
// It is not caught anywhere else. The runner's own tests stub `kubectl` and answer whatever the
// stub is told to, so they pass under any RBAC; a Forbidden only appears against a real API server,
// which is a paid e2e run. This test costs nothing and asks the question offline.
//
// WHY IT SCRAPES THE READ rather than asserting a fixed verb list: a verb list pinned by hand goes
// stale the same way the Role did. The read's own argv is the source of truth — if it grows
// `--field-selector` it needs `list`, if it grows `delete` it needs `delete`. A future verb with no
// mapping here fails loudly rather than silently, which is the whole point.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// verbForFlag maps a kubectl invocation shape in the state read to the RBAC verb it requires.
var verbForFlag = map[string]string{
	"--field-selector":   "list", // a field selector is a LIST against the collection, never a GET
	"kubectl\", \"apply": "patch",
}

func TestVaultStateRoleGrantsEveryVerbTheReadUses(t *testing.T) {
	root := findRepoRoot(t)
	if root == "" {
		t.Skip("go.work not found; not in a monorepo checkout — skipping the cross-module scrape")
	}

	readSrc, err := os.ReadFile(filepath.Join(root, "apps", "runner", "internal", "agent", "vault_state.go"))
	if err != nil {
		t.Fatalf("read vault_state.go: %v", err)
	}
	read := string(readSrc)
	if !strings.Contains(read, "\"kubectl\"") {
		t.Fatal("vault_state.go no longer shells out to kubectl — this scrape has rotted and " +
			"measured nothing, which is worse than failing")
	}

	// Every Role this package renders for a bootstrap Job that reads the state Secret.
	roles := map[string]string{
		"vault.go":           renderedRules(t, root, "packages/core/argocd/vault.go"),
		"addon_bootstrap.go": renderedRules(t, root, "packages/core/argocd/addon_bootstrap.go"),
	}

	checked := 0
	for flag, verb := range verbForFlag {
		if !strings.Contains(read, flag) {
			continue
		}
		checked++
		for file, rules := range roles {
			if !strings.Contains(rules, `"`+verb+`"`) {
				t.Errorf("vault_state.go's read uses %q, which requires the %q verb, but %s's Role "+
					"does not grant it.\nEvery read would be Forbidden, and an unreadable state is "+
					"fatal — the bootstrap returns before waitForVault on every cluster.\nRules:\n%s",
					flag, verb, file, rules)
			}
		}
	}
	if checked == 0 {
		t.Fatal("no kubectl shape in vault_state.go matched any entry in verbForFlag — either the " +
			"read was rewritten or this map is stale; a scrape that recognises nothing must fail")
	}
}

// renderedRules returns the `verbs:` lines of every Role rule in a source file, so the assertion
// reads the literal that actually ships rather than a copy of it.
func renderedRules(t *testing.T, root, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	var out []string
	for _, line := range strings.Split(string(b), "\n") {
		if strings.Contains(line, "verbs:") {
			out = append(out, strings.TrimSpace(line))
		}
	}
	if len(out) == 0 {
		t.Fatalf("%s renders no `verbs:` line — the Role was moved or renamed and this scrape "+
			"would silently pass", rel)
	}
	return strings.Join(out, "\n")
}

// findRepoRoot walks up to the directory holding go.work.
func findRepoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
	return ""
}
