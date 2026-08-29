// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// No kubectlRead call may hand over an EMPTY kubeconfig path.
//
// `kubectlRead` prepends `--kubeconfig <path>` to every invocation. kubectl does NOT reject an
// empty value for that flag — it falls back to its default loading rules ($KUBECONFIG, then
// ~/.kube/config, then localhost:8080). Verified: `kubectl --kubeconfig "" config current-context`
// answers `error: current-context is not set`, i.e. it went looking, rather than refusing the flag.
//
// So a read with an empty path does not fail. It succeeds against WHATEVER CLUSTER the machine is
// pointed at, and the dump then reports that answer as though it came from the cluster under test.
// On a laptop that is usually nothing; on a runner with a kubeconfig in the environment it is a
// different cluster, and the diagnostic is confidently wrong rather than absent.
//
// This is a source scrape rather than a behavioural test because the defect lives at the CALL
// SITE: #3404 consolidated two kubectl helpers into `kubectlRead` and, at one of the three call
// sites it converted, passed "" while stripping the `--kubeconfig <path>` pair the args already
// carried — dropping the path entirely instead of avoiding a duplicate. The other two passed
// `kubeconfigPath` correctly, so nothing about the helper or its own tests could notice.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// An empty-string literal in the kubeconfig position: kubectlRead(ctx, <timeout>, "", …).
var emptyKubeconfigRead = regexp.MustCompile(`kubectlRead\([^,]+,[^,]+,\s*""\s*,`)

func TestNoKubectlReadPassesAnEmptyKubeconfig(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read test/e2e: %v", err)
	}

	scanned, callSites := 0, 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || name == "kubectl_read_kubeconfig_pure_test.go" {
			continue
		}
		src, err := os.ReadFile(filepath.Join(".", name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		text := string(src)
		scanned++
		callSites += strings.Count(text, "kubectlRead(")

		for _, line := range strings.Split(text, "\n") {
			if emptyKubeconfigRead.MatchString(line) {
				t.Errorf("%s: kubectlRead is passed an empty kubeconfig path:\n    %s\n"+
					"kubectl does not reject `--kubeconfig \"\"` — it falls back to $KUBECONFIG, "+
					"~/.kube/config, then localhost:8080. The read then answers from whatever "+
					"cluster the machine is pointed at, and the dump reports it as the cluster "+
					"under test.", name, strings.TrimSpace(line))
			}
		}
	}

	// A scrape that read nothing, or that found no call sites, proves nothing — and this file's
	// whole subject is a check that looked like it passed while measuring the wrong thing.
	if scanned == 0 {
		t.Fatal("scanned no .go files in test/e2e — the scrape measured nothing")
	}
	if callSites == 0 {
		t.Fatalf("found no kubectlRead call sites across %d file(s) — either the helper was "+
			"renamed or this scrape has rotted; it must fail rather than pass quietly", scanned)
	}
	t.Logf("scanned %d file(s), %d kubectlRead call site(s)", scanned, callSites)
}
