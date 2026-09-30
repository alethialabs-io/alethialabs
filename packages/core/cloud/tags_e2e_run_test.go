// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"os"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The `e2e-run` sweep handle (#5096) is not a special case in this package, and these tests pin
// that it does not need to be one.
//
// A stack the CLI creates gets its ProjectConfig from the console, so its ID — and therefore its
// `project-id` sweep handle — is the project's UUID, and the e2e sweepers (which select on
// `project-id=e2e-*`) could not see it. The fix is a real product input rather than an e2e knob:
// the cli-demo org defines an `e2e-run` CLASSIFICATION dimension and the CLI assigns it, so it
// arrives in ProjectConfig.Classification exactly as a customer's classification does, and this
// file renders it like any other dimension. The seeded e2e paths put the same value into the
// snapshot they build. What must hold for the sweepers to find it is below: the rendered KEY on
// every cloud, the VALUE untouched by any cloud's charset folding, and the scripts naming those keys.

// e2eRunValue is the shape the harness writes: `e2e-<run_id>-<attempt>`.
const e2eRunValue = "e2e-36135826614-1"

// cliDemoConfig is a CLI-created stack as the console hands it to the runner: a UUID id and the
// e2e-run classification the CLI assigned.
func cliDemoConfig() *types.ProjectConfig {
	return &types.ProjectConfig{
		ID:             "3e9d7e82-6bfc-4faa-9006-7c1e27d72249",
		EnvironmentID:  "0b7d3f5e-1c2a-4e8b-9f10-2a3b4c5d6e7f",
		Classification: map[string][]string{"e2e-run": {e2eRunValue}},
	}
}

// e2eRunKeys is, per cloud, the style its ProviderTfvars builder renders with and the tag/label key
// the sweeper for that cloud selects on.
var e2eRunKeys = []struct {
	cloud  string
	style  tagStyle
	key    string
	script string
}{
	{"aws", awsTagStyle, "alethia:e2e-run", "aws-cleanup.sh"},
	{"azure", azureTagStyle, "alethia:e2e-run", "azure-cleanup.sh"},
	{"gcp", gcpTagStyle, "alethia_e2e-run", "gcp-cleanup.sh"},
	{"hetzner", hetznerTagStyle, "alethia_e2e-run", "hcloud-cleanup.sh"},
	// alibaba renders the handle like any other cloud; its sweeper deliberately does not scan it yet
	// (the cli-demo dimension excludes alibaba, #4227), so no script is cross-checked for it.
	{"alibaba", alibabaTagStyle, "alethia:e2e-run", ""},
}

// TestE2ERunClassification_RendersOnEveryCloud: the dimension reaches every cloud's tag map under
// the key the sweeper reads, with the value byte-for-byte — GCP lowercases and Hetzner folds its
// charset, and neither may alter `e2e-<digits>-<digits>`, or the sweeper's exact-value filter misses.
func TestE2ERunClassification_RendersOnEveryCloud(t *testing.T) {
	for _, c := range e2eRunKeys {
		tags := classificationTags(cliDemoConfig(), c.style)
		if got := tags[c.key]; got != e2eRunValue {
			t.Errorf("%s: %s = %q, want %q (tags %v)", c.cloud, c.key, got, e2eRunValue, tags)
		}
	}
}

// TestE2ERunClassification_ProjectIDStaysTheUUID: the new handle is ADDED, and the old one keeps
// its meaning. A CLI stack's project-id is its UUID — which is precisely why the sweepers need the
// second handle, and why they must never treat a non-`e2e-` project-id as a run.
func TestE2ERunClassification_ProjectIDStaysTheUUID(t *testing.T) {
	cfg := cliDemoConfig()
	for _, c := range e2eRunKeys {
		tags := classificationTags(cfg, c.style)
		pidKey, _ := c.style.render("project-id", "x")
		if got := tags[pidKey]; got != cfg.ID {
			t.Errorf("%s: %s = %q, want the project UUID %q", c.cloud, pidKey, got, cfg.ID)
		}
	}
}

// TestE2ERunClassification_KubernetesLabel: the same dimension reaches the ArgoCD objects Alethia
// renders, under the alethia.io/ prefix, so in-cluster attribution matches the cloud's.
func TestE2ERunClassification_KubernetesLabel(t *testing.T) {
	labels := ClassificationLabels(cliDemoConfig())
	if got := labels["alethia.io/e2e-run"]; got != e2eRunValue {
		t.Errorf("alethia.io/e2e-run = %q, want %q (labels %v)", got, e2eRunValue, labels)
	}
}

// TestE2ERunClassification_SweepersSelectOnTheRenderedKey ties the renderer to the sweepers. The
// key each script scans for is written into it as a literal (the `alethia` namespace, then the
// cloud's separator, then the handle name), and nothing else checks that it is the key this file
// renders. If a tag style's separator or casing ever changes, the product would stamp one key and
// the reaper would look for another — and a reaper that finds nothing reports a clean account.
func TestE2ERunClassification_SweepersSelectOnTheRenderedKey(t *testing.T) {
	for _, c := range e2eRunKeys {
		if c.script == "" {
			continue
		}
		b, err := os.ReadFile("../../../scripts/e2e/" + c.script)
		if err != nil {
			t.Fatalf("%s: reading its sweeper: %v", c.cloud, err)
		}
		if !strings.Contains(string(b), c.key) {
			t.Errorf("%s: scripts/e2e/%s never names %q, the key this package renders the e2e-run "+
				"handle as — its preflight cannot find a CLI-created stack", c.cloud, c.script, c.key)
		}
		pidKey, _ := c.style.render("project-id", "x")
		if !strings.Contains(string(b), pidKey) {
			t.Errorf("%s: scripts/e2e/%s no longer names %q — every stack standing from before the "+
				"e2e-run handle carries only that key, and dropping it makes them invisible", c.cloud, c.script, pidKey)
		}
	}
}
