// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"errors"
	"io"
	"sort"
	"testing"

	"gopkg.in/yaml.v3"
)

// renderedApp is the slice of a rendered Application this test reads.
type renderedApp struct {
	Kind     string `yaml:"kind"`
	Metadata struct {
		Name string `yaml:"name"`
	} `yaml:"metadata"`
	Spec struct {
		SyncPolicy struct {
			Automated *struct {
				Prune      bool  `yaml:"prune"`
				SelfHeal   bool  `yaml:"selfHeal"`
				AllowEmpty *bool `yaml:"allowEmpty"`
			} `yaml:"automated"`
		} `yaml:"syncPolicy"`
	} `yaml:"spec"`
}

// renderedApplications parses every Application out of a full render, keyed by name.
func renderedApplications(t *testing.T, files map[string]string) map[string]renderedApp {
	t.Helper()
	out := map[string]renderedApp{}
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, file := range names {
		dec := yaml.NewDecoder(bytes.NewBufferString(files[file]))
		for {
			var doc renderedApp
			err := dec.Decode(&doc)
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				t.Fatalf("%s: %v", file, err)
			}
			if doc.Kind == "Application" {
				out[doc.Metadata.Name] = doc
			}
		}
	}
	return out
}

// The `addons` app-of-apps must be able to REACH an empty addons/ directory, not only start in one
// (#5210). Without automated.allowEmpty, ArgoCD's auto-sync refuses a sync that would prune every
// live resource ("auto-sync will wipe out all resources") and parks the Application Healthy +
// OutOfSync for good — which is what re-pointing an environment at alethia-starter-apps did on
// hetzner/templates run 36901344033, and what disabling a customer's last gitops add-on would do.
//
// It is read from the PARSED render, not grepped: a comment containing "allowEmpty: true" must not
// pass this, and the key must sit under spec.syncPolicy.automated to mean anything to ArgoCD.
//
// The boundary is stated, and checked in the other direction: allowEmpty is the addons
// Application's alone. Every other automated platform Application keeps ArgoCD's guard, so a
// render that empties the user's root `apps` (a wrong apps_path, say) is still refused rather than
// pruning the customer's workloads. Widening it is a decision for its own PR, not a side effect.
func TestAddonsApplicationAllowsAnEmptyAddonsDirectory(t *testing.T) {
	apps := renderedApplications(t, renderAll(t, BuildFromOutputs(map[string]interface{}{}, cfg("hetzner"))))

	addons, ok := apps["addons"]
	if !ok {
		t.Fatalf("addon-apps.yaml rendered no `addons` Application with an apps repo set; got %v", appNames(apps))
	}
	a := addons.Spec.SyncPolicy.Automated
	if a == nil || !a.Prune || !a.SelfHeal {
		t.Fatalf("addons: automated prune+selfHeal is the contract this test assumes; got %+v", a)
	}
	if a.AllowEmpty == nil || !*a.AllowEmpty {
		t.Errorf("addons: spec.syncPolicy.automated.allowEmpty must be true — without it an emptied addons/ is never pruned (#5210)")
	}

	if len(apps) < 2 {
		t.Fatalf("only %d Application(s) rendered — the other-direction check below would be vacuous: %v", len(apps), appNames(apps))
	}
	for name, app := range apps {
		if name == "addons" {
			continue
		}
		if am := app.Spec.SyncPolicy.Automated; am != nil && am.AllowEmpty != nil && *am.AllowEmpty {
			t.Errorf("%s: allowEmpty is set — only the addons app-of-apps may prune to empty; ArgoCD's guard stays on everything else", name)
		}
	}
}

// appNames lists rendered Application names for a failure message.
func appNames(apps map[string]renderedApp) []string {
	out := make([]string, 0, len(apps))
	for n := range apps {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}
