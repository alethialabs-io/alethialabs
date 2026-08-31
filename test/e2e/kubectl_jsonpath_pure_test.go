// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// jsonpathRead matches a kubectl invocation that asks for a jsonpath value.
var jsonpathRead = regexp.MustCompile(`jsonpath=`)

// TestNoJsonpathReadFoldsStderrIntoTheValue — a kubectl read whose STDOUT IS A VALUE must not use
// CombinedOutput.
//
// kubectl writes to stderr on calls that SUCCEED: a `Warning:` deprecation header, or an
// exec-credential plugin's notice, which is the ordinary shape of authenticating to EKS, GKE and
// AKS. CombinedOutput fuses that into the value, so
//
//	kubectl get application X -o jsonpath={.spec.syncPolicy.automated}
//
// returns `Warning: …\n{"prune":true,"selfHeal":true}`. The consequences are not cosmetic:
// assertByoAutoSyncPolicy json.Unmarshals it and fails a PAID run naming a policy that was never
// wrong; argoHardRefreshVerdict maps it to a sync verdict and matches neither state.
//
// kubectlRead (kubectl_read.go) is the one way to do this: it keeps stderr OUT of the value, keeps
// partial stdout on failure, and folds kubectlErrorLine into the error so the failure path still
// says what kubectl said.
//
// ⚠️ THIS IS THE GUARD THAT WAS MISSING. TestOnlyOneKubectlReadHelperExists checks that no SECOND
// helper is defined; nothing checked that the CALL SITES use the one that exists. Five did not.
func TestNoJsonpathReadFoldsStderrIntoTheValue(t *testing.T) {
	t.Parallel()

	files, err := filepath.Glob("*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("could not list package sources (%v) — this test cannot check anything", err)
	}
	scannedReads := 0
	var offenders []string
	for _, f := range files {
		raw, rerr := os.ReadFile(f)
		if rerr != nil {
			t.Fatalf("could not read %s: %v", f, rerr)
		}
		lines := strings.Split(string(raw), "\n")
		for i, line := range lines {
			if !jsonpathRead.MatchString(line) {
				continue
			}
			scannedReads++
			// The reader is within a few lines of the argv that asked for the jsonpath — the
			// invocation and its consumption are one statement in every shape this package uses.
			for j := i; j < len(lines) && j <= i+6; j++ {
				if strings.Contains(lines[j], "CombinedOutput()") {
					offenders = append(offenders, f+":"+itoa(j+1))
					break
				}
			}
		}
	}
	// Guards the guard: a rename of the jsonpath spelling, or a move of these reads out of the
	// package, would empty the scan and report success while checking nothing.
	if scannedReads == 0 {
		t.Fatal("found no jsonpath reads in this package — either they moved or the scan broke; " +
			"either way this test is no longer checking anything")
	}
	if len(offenders) > 0 {
		t.Errorf("%d jsonpath read(s) fold stderr into the value with CombinedOutput: %v\n"+
			"kubectl writes warnings to stderr on calls that SUCCEED, so the value can arrive as "+
			"`Warning: …\\n<the actual value>`. Use kubectlRead (kubectl_read.go), which keeps stderr "+
			"out of the value and still reports what kubectl said on failure.", len(offenders), offenders)
	}
	t.Logf("scanned %d jsonpath read(s) across %d file(s)", scannedReads, len(files))
}

// itoa avoids pulling strconv in for one call site in a test.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// TestNoKubectlArgvHelperFusesStreams closes the level the test above cannot see.
//
// The jsonpath scan looks at CALL SITES, so it is blind to a wrapper: `nsKubectl(ctx, kc, "get",
// "sa", …, "-o", "jsonpath=…")` contains no CombinedOutput of its own, and for a long time the
// fusion lived one level down inside nsKubectl — where it broke the ServiceAccount-annotation
// assertions in both directions at once (an absent annotation read as present, because the
// stderr warning satisfied `TrimSpace(out) != ""`).
//
// So: a helper that runs kubectl with an arbitrary argv must not use CombinedOutput. Those are
// exactly the functions whose return value some caller will parse.
func TestNoKubectlArgvHelperFusesStreams(t *testing.T) {
	t.Parallel()

	files, err := filepath.Glob("*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("could not list package sources (%v) — this test cannot check anything", err)
	}
	helper := regexp.MustCompile(`(?m)^func ([A-Za-z0-9_]+)\([^)]*args \.\.\.string\)`)
	scanned := 0
	var offenders []string
	for _, f := range files {
		raw, rerr := os.ReadFile(f)
		if rerr != nil {
			t.Fatalf("could not read %s: %v", f, rerr)
		}
		text := string(raw)
		for _, loc := range helper.FindAllStringSubmatchIndex(text, -1) {
			name := text[loc[2]:loc[3]]
			// The function body, to its closing brace at column 0.
			rest := text[loc[1]:]
			if end := strings.Index(rest, "\n}"); end >= 0 {
				rest = rest[:end]
			}
			if !strings.Contains(rest, `"kubectl"`) {
				continue // not a kubectl helper; an argv alone proves nothing
			}
			scanned++
			if strings.Contains(rest, "CombinedOutput()") {
				offenders = append(offenders, f+":"+name)
			}
		}
	}
	// Guards the guard: if no kubectl argv helper is found at all, the scan proved nothing.
	if scanned == 0 {
		t.Fatal("found no kubectl argv helpers in this package — the scan is no longer checking anything")
	}
	if len(offenders) > 0 {
		t.Errorf("%d kubectl argv helper(s) fuse stderr into the value: %v\n"+
			"Their callers parse what they return, and kubectl writes warnings to stderr on calls "+
			"that SUCCEED — so an ABSENT value reads as present and a real one arrives with a "+
			"warning glued to its front. Delegate to kubectlRead (kubectl_read.go).", len(offenders), offenders)
	}
	t.Logf("scanned %d kubectl argv helper(s)", scanned)
}
