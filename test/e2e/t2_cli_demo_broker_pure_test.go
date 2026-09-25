// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The PURE half of the cli-demo broker integration (#4227): what lifts the connector refusal, what
// the gcp connector uploads, and the pre-spend proof script's own self-test — all without a cloud,
// so ci.yml runs them on every PR.

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// refreshScript is the pre-spend broker proof e2e-nightly.yml runs, relative to this package.
var refreshScript = filepath.Join("..", "..", "scripts", "e2e", "refresh-e2e-issuer-token.mjs")

// TestCLIDemoConnectorLift pins every branch of the lift, including the ones that must NOT lift:
// a proof for another cloud, a proof for a cloud outside the broker set, and an empty environment.
func TestCLIDemoConnectorLift(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		env      map[string]string
		want     string
	}{
		{"nothing set", "aws", nil, ""},
		{"broker proven for this cloud", "aws", map[string]string{cliDemoBrokerProvenEnv: "aws"}, "broker"},
		{"broker proven, surrounding whitespace", "gcp", map[string]string{cliDemoBrokerProvenEnv: " gcp\n"}, "broker"},
		{"broker proven for azure", "azure", map[string]string{cliDemoBrokerProvenEnv: "azure"}, "broker"},
		{"broker proven for ANOTHER cloud", "gcp", map[string]string{cliDemoBrokerProvenEnv: "aws"}, ""},
		{"a boolean is not a provider", "aws", map[string]string{cliDemoBrokerProvenEnv: "1"}, ""},
		{"alibaba is excluded by ruling", "alibaba", map[string]string{cliDemoBrokerProvenEnv: "alibaba"}, ""},
		{"hetzner has no issuer to prove", "hetzner", map[string]string{cliDemoBrokerProvenEnv: "hetzner"}, ""},
		{"maintainer's manual lift", "azure", map[string]string{cliDemoConnectorIssuerTrustEnv: "1"}, "maintainer"},
		{"maintainer lift is not a falsy value", "azure", map[string]string{cliDemoConnectorIssuerTrustEnv: "0"}, ""},
		{"a measured proof outranks the statement", "aws", map[string]string{cliDemoBrokerProvenEnv: "aws", cliDemoConnectorIssuerTrustEnv: "1"}, "broker"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			getenv := func(k string) string { return c.env[k] }
			if got := cliDemoConnectorLift(c.provider, getenv); got != c.want {
				t.Errorf("cliDemoConnectorLift(%q) = %q, want %q", c.provider, got, c.want)
			}
		})
	}
}

// TestCLIDemoBrokerCloudsAreRealBlockedClouds — a broker cloud must be a provider the harness knows,
// and one whose connector is otherwise REFUSED. A broker entry for a drivable cloud would be a lift
// with nothing to lift, and one for an unknown cloud a lift nobody can reach.
func TestCLIDemoBrokerCloudsAreRealBlockedClouds(t *testing.T) {
	known := map[string]bool{}
	for _, p := range t2ProviderNames() {
		known[p] = true
	}
	if len(cliDemoBrokerClouds) == 0 {
		t.Fatal("cliDemoBrokerClouds is empty — nothing could ever lift through the broker")
	}
	for p := range cliDemoBrokerClouds {
		if !known[p] {
			t.Errorf("cliDemoBrokerClouds names %q, which is not in t2ProviderTable", p)
		}
		if cliDemoConnectorIssuerTrust[p] == "" {
			t.Errorf("cliDemoBrokerClouds names %q, whose connector is not refused — there is nothing to lift", p)
		}
	}
	if cliDemoBrokerClouds["alibaba"] {
		t.Error("alibaba is excluded from the broker proof by maintainer ruling (#4227)")
	}
}

// TestCLIDemoBrokerCloudsMatchTheProofScript — the Go lift and the script that earns it must name
// the same clouds. Read out of the script rather than restated, so neither side can grow alone: a
// cloud the script proves but Go never lifts wastes the proof, and one Go lifts that the script
// never proves could only be reached by a hand-set variable.
func TestCLIDemoBrokerCloudsMatchTheProofScript(t *testing.T) {
	src, err := os.ReadFile(refreshScript)
	if err != nil {
		t.Fatalf("read %s: %v", refreshScript, err)
	}
	m := regexp.MustCompile(`export const BROKER_CLOUDS = \[([^\]]*)\]`).FindSubmatch(src)
	if m == nil {
		t.Fatal("the proof script declares no BROKER_CLOUDS — this comparison would check nothing")
	}
	var script []string
	for _, q := range regexp.MustCompile(`"([a-z]+)"`).FindAllSubmatch(m[1], -1) {
		script = append(script, string(q[1]))
	}
	var goSide []string
	for p := range cliDemoBrokerClouds {
		goSide = append(goSide, p)
	}
	sort.Strings(script)
	sort.Strings(goSide)
	if strings.Join(script, ",") != strings.Join(goSide, ",") {
		t.Errorf("the proof script proves %v but cliDemoBrokerClouds lifts %v", script, goSide)
	}
}

// TestCLIDemoGCPConnectorUploadsTheBrokerConfig — on gcp the connector must upload the BROKER WIF
// config, never the GitHub one auth wrote. With only GOOGLE_APPLICATION_CREDENTIALS set, the flag
// value must come out EMPTY, so AssertCLIDemoConnectorIsDrivable refuses before spend instead of
// uploading a config whose pool cannot verify the console's assertion.
func TestCLIDemoGCPConnectorUploadsTheBrokerConfig(t *testing.T) {
	run := &CLIDemoRun{Provider: "gcp"}
	// The project is the OTHER gcp flag; populated so the only empty value left is the one asked about.
	t.Setenv("GOOGLE_PROJECT", "alethia-e2e-proj")
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "/runner/gha-creds.json")
	t.Setenv(cliDemoGCPWifConfigEnv, "")
	empty := cliDemoConnectorEmptyFlags(run)
	if len(empty) != 1 || empty[0] != "--wif-config" {
		t.Errorf("with no broker config, the empty flags are %v — want exactly [--wif-config]", empty)
	}
	for _, a := range cliDemoConnectorArgs(run) {
		if a == "/runner/gha-creds.json" {
			t.Error("the connector uploads the GitHub-pool config google-github-actions/auth wrote")
		}
	}

	t.Setenv(cliDemoGCPWifConfigEnv, "/runner/broker-wif.json")
	argv := cliDemoConnectorArgs(run)
	idx := -1
	for i, a := range argv {
		if a == "--wif-config" {
			idx = i
		}
	}
	if idx < 0 || idx+1 >= len(argv) || argv[idx+1] != "/runner/broker-wif.json" {
		t.Errorf("connector gcp argv %v does not pass the broker WIF config", argv)
	}
}

// TestRefreshE2EIssuerTokenSelfTest runs the proof script's own offline self-test — every refusal it
// makes, every claim it checks, and that no token reaches its output. ci.yml runs this package on
// every PR, so a regression in the script reds the PR rather than the next paid dispatch.
//
// node is REQUIRED, not optional: a skip here would be a green PR that never ran the script's tests.
func TestRefreshE2EIssuerTokenSelfTest(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatalf("node is not on PATH — the broker proof script's self-test cannot run: %v", err)
	}
	out, err := exec.Command(node, refreshScript, "--self-test").CombinedOutput()
	if err != nil {
		t.Fatalf("refresh-e2e-issuer-token.mjs --self-test failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "self-test: all passed") {
		t.Fatalf("the self-test exited 0 without reporting a pass — it may have checked nothing:\n%s", out)
	}
}
