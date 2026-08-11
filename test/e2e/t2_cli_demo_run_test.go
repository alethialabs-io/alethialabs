// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

// CLI-ONLY DEMO — the e2e_t2-tagged half that checks the table in t2_cli_demo.go against a REAL
// `alethia` binary. The pure half proves the table is well-formed; only this half proves it is
// TRUE.
//
// # Why a table alone would be worthless here
//
// Every claim in t2_cli_demo.go is a claim about a binary that lives outside this module. A
// hand-maintained list of "commands we have" is precisely the artifact that goes stale silently:
// it costs nothing to leave a step marked CLIDriven after the command is renamed, and nothing to
// leave a gap listed after somebody closes it. Both directions are checked here, and the second
// one matters more than it looks:
//
//   - CLIDriven  ⇒ `alethia <Argv...> --help` MUST exit 0. A renamed or never-shipped command
//     turns an optimistic table entry into a red test instead of a surprise on stage.
//   - CLIGap     ⇒ `alethia <WantArgv...> --help` MUST exit non-zero. This is the RATCHET. The
//     day somebody ships `alethia verify receipt`, this test goes red and the table has to be
//     updated to record the win. Without the inversion, a closed gap would sit in the report
//     forever, understating the product to the exact audience the report is written for.
//
// # What this deliberately does NOT do
//
// It does not provision. Driving a full demo end to end costs a real cluster, and the T2 spine
// already proves the provisioning half in TestT2RealCloudProvisioning; re-driving it through the
// CLI would double the bill to re-prove it. What is unproven WITHOUT this file is reachability —
// whether a human at a terminal can get to each step — and reachability is answered by the
// command surface.
//
// A narrated, actually-provisioning variant is a reasonable follow-up. It is deliberately NOT
// named here as a future env var: TestScenarioEnablesReachTheNightly scans this directory for
// ALETHIA_E2E_* strings, and a variable that exists only in a comment is the "dead but looks
// alive" shape that guard was written to kill. It needs a demo org, a funded account and its own
// budget line in ResolveT2Budget — so it gets its own issue, not a placeholder.

package e2e

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// cliHelpResolves reports whether `alethia <argv...> --help` exits 0 — cobra's answer to "does
// this command exist?". An unknown command exits non-zero with `unknown command "…" for "alethia"`.
func cliHelpResolves(t *testing.T, bin string, argv []string) (bool, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	args := append(append([]string{}, argv...), "--help")
	cmd := exec.CommandContext(ctx, bin, args...)
	// A demo runs on a fresh machine; make sure no ambient config turns a missing command into a
	// prompt that hangs until the context kills it and reads as "does not resolve".
	cmd.Env = append(os.Environ(), "ALETHIA_NO_UPDATE_CHECK=1")
	out, err := cmd.CombinedOutput()
	return err == nil, strings.TrimSpace(string(out))
}

func TestT2CLIDemoReachability(t *testing.T) {
	if !CLIDemoEnabled() {
		t.Skip("ALETHIA_E2E_CLI_DEMO is not set — the CLI-only demo bar is opt-in")
	}

	bin := CLIDemoBinary()
	// Fail, never skip, when the binary is absent. A scenario the maintainer switched ON that
	// then quietly skips is the exact failure mode nightly_reachability_test.go exists to stop
	// (#1341: a harness no variable ever set, shipped and never executed).
	if ok, out := cliHelpResolves(t, bin, nil); !ok {
		t.Fatalf("the CLI under test (%q) does not run — ALETHIA_E2E_CLI_BIN must point at a real `alethia`.\n%s", bin, out)
	}

	// Report the version under test. v0.4.0 predates both `project ... placement` (#2313) and
	// `connector hetzner` (#2316), so a green run against a stale binary would prove the wrong
	// thing; recording it makes the proof bundle self-describing.
	if v, err := exec.Command(bin, "--version").CombinedOutput(); err == nil {
		t.Logf("CLI under test: %s", strings.TrimSpace(string(v)))
	}

	cloud := strings.TrimSpace(os.Getenv("ALETHIA_E2E_PROVIDER"))
	if cloud == "" {
		cloud = "aws"
	}
	proof, err := ScoreCLIDemo(cloud)
	if err != nil {
		t.Fatalf("the demo table does not score for %q: %v", cloud, err)
	}

	for _, s := range CLIDemoSteps {
		if !s.AppliesTo(cloud) {
			continue
		}
		switch s.Reach {
		case CLIDriven:
			t.Run("driven/"+s.ID, func(t *testing.T) {
				ok, out := cliHelpResolves(t, bin, s.Argv)
				if !ok {
					t.Errorf("step %q claims CLIDriven via `alethia %s`, but that command does not resolve.\n"+
						"Either the command was renamed and the table is stale, or the claim was never true.\n%s",
						s.ID, strings.Join(s.Argv, " "), out)
				}
			})
		case CLIGap:
			t.Run("gap/"+s.ID, func(t *testing.T) {
				ok, _ := cliHelpResolves(t, bin, s.WantArgv)
				if ok {
					t.Errorf("step %q is recorded as a CLI GAP (%s), but `alethia %s` NOW RESOLVES.\n"+
						"The gap is closed — update t2_cli_demo.go to CLIDriven and close the issue. "+
						"This test is red on purpose: a fixed gap left in the report understates the product.",
						s.ID, s.Issue, strings.Join(s.WantArgv, " "))
				}
			})
		case CloudManual, ConsoleOnly:
			// Nothing to execute: the claim is that no command exists on either side. The pure
			// half already enforces that such a step names no Argv, and the Why/Issue that make
			// it auditable.
		}
	}

	t.Log("\n" + proof.Summary())

	if !proof.Passed() {
		t.Logf("CLI-only demo bar for %s: %s", cloud, proof.Verdict())
		// Per the maintainer's ruling for the investor benchmark, a gap or a ceiling is a FAIL —
		// a prospect cannot tell whose fault the click is. The failure is recorded, never hidden.
		t.Errorf("cloud %s does NOT clear the CLI-only demo bar: %s", cloud, proof.Verdict())
	}
}
