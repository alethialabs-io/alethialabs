// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
)

// `alethia init --addon <id>[@<version>]` (#5528) writes the add-ons into the new file's first
// environment, checked against the server's catalog first.

func TestInit_AddonFlagsWriteTheFirstEnvironmentsAddons(t *testing.T) {
	s := &projServer{}
	h := upEnv(t, s)
	dir := chdirTo(t)
	if h.run("init", "--web-origin", WebOrigin(), "--project", "boutique",
		"--region", "eu-west-1", "--cloud-account", "prod-account", "--no-input",
		"--addon", "cert-manager", "--addon", "external-dns@1.15.0") {
		t.Fatal("init exited fatally")
	}
	raw, err := os.ReadFile(filepath.Join(dir, manifest.FileName))
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	want := "    addons:\n      - id: cert-manager\n      - id: external-dns\n        version: 1.15.0\n"
	if !strings.Contains(text, want) {
		t.Errorf("the rendered manifest does not carry the add-ons as\n%s\ngot:\n%s", want, text)
	}
	m, err := manifest.Load(filepath.Join(dir, manifest.FileName))
	if err != nil {
		t.Fatalf("init wrote a manifest that does not load: %v", err)
	}
	if got := m.Environments[0].Addons; len(got) != 2 || got[1].Version == nil || *got[1].Version != "1.15.0" {
		t.Errorf("add-ons read back as %+v", got)
	}
	if s.hits("/api/cli/schema/addons") == 0 {
		t.Error("the add-ons were written without checking them against the catalog")
	}
}

func TestInit_WithoutAddonFlagsReadsNoCatalogAndWritesNoAddons(t *testing.T) {
	s := &projServer{}
	h := upEnv(t, s)
	dir := chdirTo(t)
	if h.run("init", "--web-origin", WebOrigin(), "--project", "boutique",
		"--region", "eu-west-1", "--cloud-account", "prod-account", "--no-input") {
		t.Fatal("init exited fatally")
	}
	raw, err := os.ReadFile(filepath.Join(dir, manifest.FileName))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "addons") {
		t.Errorf("a file without --addon grew an addons key:\n%s", raw)
	}
	if s.hits("/api/cli/schema/addons") != 0 {
		t.Error("init fetched the add-on catalog with no add-on to check")
	}
}

func TestInit_AddonFlagRefusals(t *testing.T) {
	for name, tc := range map[string]struct{ flag, want string }{
		"unknown id":    {"not-an-addon", `"not-an-addon" is not a catalog add-on`},
		"version range": {"external-dns@^1.15", `version "^1.15"`},
		"empty version": {"external-dns@", "nothing after @"},
	} {
		t.Run(name, func(t *testing.T) {
			h := upEnv(t, &projServer{})
			dir := chdirTo(t)
			if !h.run("init", "--web-origin", WebOrigin(), "--project", "boutique",
				"--region", "eu-west-1", "--cloud-account", "prod-account", "--no-input", "--addon", tc.flag) {
				t.Fatal("init accepted a bad --addon")
			}
			if manifest.Exists(filepath.Join(dir, manifest.FileName)) {
				t.Error("a manifest was written although an --addon was refused")
			}
			// The sentence, from the same two steps initAddons runs.
			addons, err := parseInitAddons([]string{tc.flag})
			if err == nil {
				err = manifest.ValidateAddons("--addon", addons, addonCatalog(), addonModeValues())
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("refusal = %v, want it to say %q", err, tc.want)
			}
		})
	}
}
