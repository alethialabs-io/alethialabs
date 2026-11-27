// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// goreleaserPath is the release config, relative to this package.
const goreleaserPath = "../../.goreleaser.yml"

// The part of the release config this test reads.
type releaseConfig struct {
	Before struct {
		Hooks []string `yaml:"hooks"`
	} `yaml:"before"`
	Archives []struct {
		Files []yaml.Node `yaml:"files"`
	} `yaml:"archives"`
	Brews []struct {
		Install string `yaml:"install"`
	} `yaml:"brews"`
	Nfpms []struct {
		Contents []struct {
			Src string `yaml:"src"`
			Dst string `yaml:"dst"`
		} `yaml:"contents"`
	} `yaml:"nfpms"`
}

// The directories the release hook writes, relative to the checkout root GoReleaser runs in.
const (
	releaseManDir         = "manpages"
	releaseCompletionsDir = "completions"
)

// TestGoreleaserShipsWhatThisWrites holds .goreleaser.yml and this program together: the hook runs
// this program into the two directories, every archive packs both, the Homebrew formula installs
// the bash, zsh and fish scripts by the names this program gives them and the man pages, and the
// Linux packages place the same files. A rename on either side fails here rather than in the first
// release that ships without them.
func TestGoreleaserShipsWhatThisWrites(t *testing.T) {
	raw, err := os.ReadFile(goreleaserPath)
	if err != nil {
		t.Fatalf("read %s: %v", goreleaserPath, err)
	}
	var cfg releaseConfig
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("parse %s: %v", goreleaserPath, err)
	}

	hooks := strings.Join(cfg.Before.Hooks, "\n")
	for _, want := range []string{
		"./tools/gendocs -man ../../" + releaseManDir + " -completions ../../" + releaseCompletionsDir,
		"gzip -9n " + releaseManDir + "/*.1",
	} {
		if !strings.Contains(hooks, want) {
			t.Errorf("no before hook runs %q", want)
		}
	}

	if len(cfg.Archives) == 0 {
		t.Fatal("the config has no archive")
	}
	for i, a := range cfg.Archives {
		srcs := map[string]bool{}
		for _, f := range a.Files {
			var entry struct {
				Src string `yaml:"src"`
			}
			if f.Kind == yaml.MappingNode {
				if err := f.Decode(&entry); err != nil {
					t.Fatal(err)
				}
				srcs[entry.Src] = true
			}
		}
		for _, dir := range []string{releaseManDir, releaseCompletionsDir} {
			if !srcs[dir+"/*"] {
				t.Errorf("archive %d does not pack %s/*", i, dir)
			}
		}
	}

	if len(cfg.Brews) == 0 {
		t.Fatal("the config has no Homebrew formula")
	}
	install := cfg.Brews[0].Install
	for _, shell := range []string{"bash", "zsh", "fish"} {
		if !strings.Contains(install, `"`+releaseCompletionsDir+"/"+completionFile[shell]+`"`) {
			t.Errorf("the formula does not install the %s completion %s", shell, completionFile[shell])
		}
	}
	if !strings.Contains(install, `man1.install Dir["`+releaseManDir+`/*.1.gz"]`) {
		t.Error("the formula does not install the man pages")
	}

	if len(cfg.Nfpms) == 0 {
		t.Fatal("the config has no Linux package")
	}
	srcs := map[string]bool{}
	for _, c := range cfg.Nfpms[0].Contents {
		srcs[c.Src] = true
	}
	for _, want := range []string{
		"./" + releaseManDir + "/*.1.gz",
		"./" + releaseCompletionsDir + "/" + completionFile["bash"],
		"./" + releaseCompletionsDir + "/" + completionFile["zsh"],
		"./" + releaseCompletionsDir + "/" + completionFile["fish"],
	} {
		if !srcs[want] {
			t.Errorf("the Linux packages do not carry %s", want)
		}
	}
}
