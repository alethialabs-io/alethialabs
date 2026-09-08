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
	"strings"
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
			"built by the new Go, or every required Go job reds). Bump them together. A new toolchain "+
			"can also MOVE coverage with no code change (Go 1.27 moved test/e2e by 0.4 points on an "+
			"identical tree): find out which statements before re-recording a floor.", got, want, want, got)
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
//
// MINOR, not patch, for the same reason the builder image is compared on the minor: dependabot's
// go-minor-patch group runs `go mod tidy`, and a dep requiring a newer patch moves the `go` line
// of the modules it touches and no others (#2404 left go.work and apps/runner at 1.26.6 with cli,
// core and e2e at 1.26.5). That is harmless — a module's `go` line is a minimum language version,
// and the language and GODEBUG surface is the minor — and requiring patch equality would turn
// every Go patch release into a hand five-file commit before that dependabot PR could be green.
// apps/cli is also published standalone (mirror-cli), where a patch-level minimum only forces a
// consumer's toolchain download for no gain.
func TestWorkspaceModulesGoMinorMatchGoWork(t *testing.T) {
	root := repoRoot(t)
	if root == "" {
		t.Skip("go.work not found; not in a monorepo checkout — skipping the toolchain scrape")
	}
	work := readRepoFile(t, root, "go.work")

	// `go 1.NN.P` — capture the minor only.
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
				"and the golangci-lint pin in ci.yml. Bump them together, and if coverage moves with "+
				"no code change, find out which statements before re-recording a floor.", rel, mm[1], want, want)
		}
	}
}

// ── The sandbox box's Go toolchain ───────────────────────────────────────────────
//
// infra/sandbox/templates/cloud-init.yaml.tftpl carried the literal `go1.24.5` under a
// comment claiming it was "kept in sync with the toolchain the repo's go.work targets".
// It was stale the day it was written (#1535 wrote 1.24.5 while #1491 raised go.work to
// 1.26.5) and three minors adrift by #4241 — because a comment is not a measurement.
//
// WHY IT NEVER SHOWED. Nothing on the box sets GOTOOLCHAIN, so Go's default `auto`
// downloads golang.org/toolchain@go1.NN.P into the module cache on the first `go build`
// and papers over any drift. The two cases it does not paper over are the ones the box
// exists to serve: no egress to proxy.golang.org, and GOTOOLCHAIN=local (Go's own
// hardening advice). Either one turns `pnpm env:runner` (native mode) into
// `go.work requires go >= 1.27.1 (running go 1.24.5)`.
//
// So the template no longer names a version at all: server.tf reads it out of go.work
// with `regex()` and passes it in. This test measures BOTH halves of that — that the
// template still interpolates rather than hardcodes, that server.tf still supplies the
// variable from go.work, and that server.tf's extraction pattern, RUN HERE against the
// real go.work, actually yields the version go.work declares.
//
// UNLIKE THE TWO TESTS ABOVE, a missing go.work is FATAL here rather than a skip. Those
// two compare a repo file against go.work and are honestly inert outside a checkout;
// this one is the only thing standing between the box and a silently re-hardcoded
// toolchain, and a scrape that reports green over nothing is the defect it exists to
// catch. Every path below fails loudly for the same reason — including a
// cloud-init.yaml.tftpl that has moved (readRepoFile fatals on a missing file).
const (
	sandboxCloudInit = "infra/sandbox/templates/cloud-init.yaml.tftpl"
	sandboxServerTF  = "infra/sandbox/server.tf"
)

func TestSandboxBoxGoToolchainComesFromGoWork(t *testing.T) {
	root := repoRoot(t)
	if root == "" {
		t.Fatal("go.work not found by walking up from this test — nothing to compare the sandbox " +
			"box's Go toolchain against, and a scrape that measures nothing must fail, not pass")
	}
	work := readRepoFile(t, root, "go.work")

	// `go 1.NN.P` — the FULL version, unlike the two tests above: go.dev/dl publishes no
	// minor-only tarball, so the box needs the patch.
	workRe := regexp.MustCompile(`(?m)^go[ \t]+(\d+\.\d+(?:\.\d+)?)\b`)
	wm := workRe.FindStringSubmatch(work)
	if wm == nil {
		t.Fatal("go.work has no `go <version>` directive — this test measured nothing, which is " +
			"the failure mode it exists to prevent")
	}
	want := wm[1]

	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(want) {
		t.Errorf("go.work says `go %s`, but the box's download URL needs a full go1.NN.P — "+
			"go.dev/dl has published no minor-only tarball since 1.21, so https://go.dev/dl/go%s"+
			".linux-amd64.tar.gz would 404. curl -f then fails inside cloud-init's `||` group and "+
			"the box comes up with NO Go at all. Pin the patch in go.work.", want, want)
	}

	// ── Half one: the template must interpolate, not hardcode ────────────────────
	tmpl := readRepoFile(t, root, sandboxCloudInit)
	dlRe := regexp.MustCompile(`https://go\.dev/dl/go(\S+?)\.linux-amd64\.tar\.gz`)
	dls := dlRe.FindAllStringSubmatch(tmpl, -1)
	switch len(dls) {
	case 1: // the shape this test understands
	case 0:
		t.Fatalf("%s has no `https://go.dev/dl/go<version>.linux-amd64.tar.gz` — either the Go "+
			"install was moved out of cloud-init or this scrape has rotted. Either way it now "+
			"measures NOTHING, which is exactly the state #4248 was filed about.", sandboxCloudInit)
	default:
		t.Fatalf("%s references the Go tarball %d times; this test asserts about one install and "+
			"would leave the others unmeasured. Re-anchor it before adding a second.",
			sandboxCloudInit, len(dls))
	}
	got := dls[0][1]

	if got != "${go_version}" {
		t.Fatalf("%s installs Go %q as a LITERAL (go.work says %s). A literal here cannot track "+
			"go.work and has already gone three minors stale once — the comment above it said it "+
			"was kept in sync the whole time. Interpolate ${go_version}, which server.tf reads out "+
			"of go.work.", sandboxCloudInit, got, want)
	}

	// ── Half two: server.tf must supply it, out of go.work ───────────────────────
	server := readRepoFile(t, root, sandboxServerTF)

	if !regexp.MustCompile(`(?m)^[ \t]*go_version[ \t]*=[ \t]*local\.go_version[ \t]*$`).MatchString(server) {
		t.Fatalf("%s renders ${go_version}, but %s does not pass `go_version = local.go_version` "+
			"into its templatefile(...) call. templatefile errors on an unsupplied variable, so "+
			"this is an apply that fails — but it fails on the maintainer's box, not here.",
			sandboxCloudInit, sandboxServerTF)
	}

	localRe := regexp.MustCompile(
		`(?m)^[ \t]*go_directive[ \t]*=[ \t]*regex\("([^"]*)",[ \t]*file\("\$\{path\.module\}/\.\./\.\./go\.work"\)\)\[0\][ \t]*$`)
	lm := localRe.FindStringSubmatch(server)
	if lm == nil {
		t.Fatalf("%s has no `go_directive = regex(\"…\", file(\"${path.module}/../../go.work\"))[0]` "+
			"local. That expression IS the mechanism — without it the box's toolchain is being "+
			"remembered again rather than read.", sandboxServerTF)
	}

	// A MINOR-ONLY DIRECTIVE IS DEFAULTED, and the defaulting is asserted here because
	// go.work carries a patch today, so nothing else would execute that branch until the
	// day somebody writes `go 1.28` — which is exactly when a missing branch bites. The
	// earlier design REFUSED a minor-only directive and failed the whole plan over a legal
	// go.work line, stopping the sandbox to avoid a URL that appending ".0" fixes.
	if !regexp.MustCompile(`(?m)^[ \t]*go_version[ \t]*=[ \t]*length\(split\("\.",[ \t]*local\.go_directive\)\)[ \t]*==[ \t]*3[ \t]*\?[ \t]*local\.go_directive[ \t]*:[ \t]*"\$\{local\.go_directive\}\.0"[ \t]*$`).MatchString(server) {
		t.Fatalf("%s does not default a minor-only `go` directive to a .0 patch. go.dev/dl "+
			"publishes no minor-only tarball, so `go 1.28` would render a URL that 404s and the "+
			"box would come up with no Go at all — but `go 1.28` is legal Go meaning 1.28.0, so "+
			"it must be SERVED rather than refused.", sandboxServerTF)
	}
	pattern := lm[1]

	// tofu's regex() is Go's regexp, so the pattern can be re-run here — but only as the
	// RAW text between the quotes. Re-implementing HCL's escaping to unquote it would be a
	// second thing to get wrong, so a backslash is refused instead: [0-9] and [.] express
	// everything \d and \. would.
	if strings.Contains(pattern, `\`) {
		t.Fatalf("the go_version pattern in %s contains a backslash (%q). This test lifts it as "+
			"RAW HCL text and deliberately does not implement HCL unescaping — write it with "+
			"[0-9] and [.] so the pattern tofu compiles and the pattern measured here are the "+
			"same string.", sandboxServerTF, pattern)
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		t.Fatalf("the go_version pattern in %s does not compile (%v); tofu's regex() would error "+
			"at plan time on the same input", sandboxServerTF, err)
	}
	m := re.FindStringSubmatch(work)
	if len(m) < 2 {
		t.Fatalf("the go_version pattern %q in %s captures nothing from go.work. tofu's regex() "+
			"errors on no match, so the sandbox stack would not plan at all.", pattern, sandboxServerTF)
	}
	if m[1] != want {
		t.Errorf("%s extracts Go %q from go.work, but go.work's `go` directive says %q. The box "+
			"would be built with a toolchain the repo does not target — which is #4248 wearing a "+
			"regex instead of a literal.", sandboxServerTF, m[1], want)
	}
}
