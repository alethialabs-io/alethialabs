// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package compat_test

// The runner's BUILDER Go version and the repo's `go.work` must agree on the minor,
// because they are the same compiler seen from two directions.
//
// Every `actions/setup-go` in this repo takes its version from `go.work` (ci.yml, codeql,
// release-cli, mirror-cli, e2e-nightly and programme.yml — a count is deliberately not stated,
// the last one to state "8" was wrong within a month). So `go.work` is what the required
// check `Go (build · vet · test · lint) (apps/runner)` compiles with, while
// `apps/runner/Dockerfile.base`'s `FROM golang:` is what compiles the /usr/local/bin/runner
// that actually ships — inherited unchanged by all five per-cloud images via `FROM runner-base`.
// When they disagree, CI green is a statement about a binary nobody shipped.
//
// WHY A TEST AND NOT CARE. The drift is ASYMMETRIC. A builder BEHIND go.work fails loudly at
// `go mod download` ("go.mod requires go >= 1.27"). A builder AHEAD is SILENT: it compiles a
// newer language and stdlib perfectly happily, and nothing anywhere reads back which compiler
// produced the artifact. #3356 was a dependabot bump of this one line to 1.27-alpine while
// go.work and all four go.mod files stayed 1.26.6; it went green and merged, and the only
// reason it was caught is that someone read the diff.
//
// This deliberately compares MINOR and not the patch. `go.work` pins a patch (1.NN.P)
// because setup-go resolves an exact toolchain; the `golang:` image tag is a minor stream
// (1.NN-alpine) that Docker Hub moves forward, and pinning a patch there would red this test on
// every upstream patch release for no safety gain — the language and stdlib surface is the minor.
//
// Not in matrix.json's static_couplings: every entry there is a Go const <-> Dockerfile ARG pair
// scraped by name, and the toolchain is neither — it is a base-image tag with no Go symbol.

import (
	"regexp"
	"testing"
)

func TestRunnerBuilderGoMinorMatchesGoWork(t *testing.T) {
	root := repoRoot(t)
	if root == "" {
		t.Skip("go.work not found; not in a monorepo checkout — skipping the toolchain scrape")
	}

	// `go 1.NN.P` — capture the minor only.
	workRe := regexp.MustCompile(`(?m)^go[ \t]+(\d+\.\d+)(?:\.\d+)?\b`)
	wm := workRe.FindStringSubmatch(readRepoFile(t, root, "go.work"))
	if wm == nil {
		t.Fatal("go.work has no `go <version>` directive — this test measured nothing, which is " +
			"the failure mode it exists to prevent")
	}
	want := wm[1]

	// `FROM --platform=$BUILDPLATFORM golang:1.NN-alpine AS builder`, patch optional.
	fromRe := regexp.MustCompile(`(?m)^FROM[^\n]*\bgolang:(\d+\.\d+)(?:\.\d+)?-`)
	dm := fromRe.FindStringSubmatch(readRepoFile(t, root, "apps/runner/Dockerfile.base"))
	if dm == nil {
		t.Fatal("apps/runner/Dockerfile.base has no `FROM … golang:<version>-` line — either the " +
			"builder stage was renamed or this scrape has rotted; a scrape that matches nothing " +
			"must fail, not pass")
	}
	got := dm[1]

	if got != want {
		t.Errorf("runner builder Go %s != go.work Go %s.\n"+
			"Every actions/setup-go resolves from go.work, so CI compiles %s while the SHIPPED "+
			"runner binary is compiled by %s — and a builder AHEAD of go.work is silent, it does "+
			"not fail the build.\n"+
			"Landing a new Go minor is a FIVE-part change: go.work, the four go.mod files, "+
			"apps/runner/Dockerfile.base, and the golangci-lint pin in ci.yml (the linter must be "+
			"built by the new Go, or every required Go job reds). Bump them together, and expect "+
			"to re-record the Go coverage floors: a new compiler counts statements differently.", got, want, want, got)
	}
}

// The four modules `go.work` uses must carry the same Go MINOR as `go.work` itself.
//
// The test above catches the builder image drifting from go.work; this one catches the OTHER
// half-done bump, which is just as silent. Go permits go.work AHEAD of a module's `go`
// directive: the lagging module compiles at the older language version with the older GODEBUG
// defaults keyed off ITS `go` line, while CI and the shipped runner both report the new toolchain.
// Nothing reds `go.work 1.27.0` next to `apps/runner/go.mod 1.26.6` — #4241 landed 1.27 as a
// single atomic change precisely because the repo's compatibility contract said so, but until
// this test the contract was prose. The module list is read from go.work's `use (...)` block so
// a fifth module is covered the day it is added, not the day someone remembers.
func TestWorkspaceModulesGoMinorMatchGoWork(t *testing.T) {
	root := repoRoot(t)
	if root == "" {
		t.Skip("go.work not found; not in a monorepo checkout — skipping the toolchain scrape")
	}
	work := readRepoFile(t, root, "go.work")

	workRe := regexp.MustCompile(`(?m)^go[ \t]+(\d+\.\d+)(?:\.\d+)?\b`)
	wm := workRe.FindStringSubmatch(work)
	if wm == nil {
		t.Fatal("go.work has no `go <version>` directive — this test measured nothing")
	}
	want := wm[1]

	// `	./apps/cli` lines inside `use ( … )`; comments and blank lines are skipped.
	useRe := regexp.MustCompile(`(?m)^[ \t]*\./(\S+)[ \t]*$`)
	uses := useRe.FindAllStringSubmatch(work, -1)
	if len(uses) < 4 {
		t.Fatalf("go.work `use` block lists %d modules; expected at least the four this repo "+
			"carries — a scrape that matches too little must fail, not pass", len(uses))
	}

	for _, u := range uses {
		rel := u[1] + "/go.mod"
		mm := workRe.FindStringSubmatch(readRepoFile(t, root, rel))
		if mm == nil {
			t.Errorf("%s has no `go <version>` directive", rel)
			continue
		}
		if mm[1] != want {
			t.Errorf("%s says go %s but go.work says go %s.\n"+
				"go.work AHEAD of a module is silent: that module compiles at the older language "+
				"version with the older GODEBUG defaults while every CI job reports %s. A Go minor "+
				"is a FIVE-part change — go.work, the four go.mod files, apps/runner/Dockerfile.base "+
				"and the golangci-lint pin in ci.yml — then re-record the Go coverage floors, "+
				"which a new compiler moves. Bump them together.", rel, mm[1], want, want)
		}
	}
}
