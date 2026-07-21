// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package git

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"github.com/go-git/go-git/v5/plumbing/transport"
)

func TestConstructorsAndURLTransforms(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"https becomes ssh", "https://github.com/acme/repo", "git@github.com:acme/repo.git"},
		{"http becomes ssh", "http://github.com/acme/repo.git", "git@github.com:acme/repo.git"},
		{"ssh shorthand untouched", "git@github.com:acme/repo.git", "git@github.com:acme/repo.git"},
		{"file transport untouched", "file:///tmp/repo", "file:///tmp/repo"},
		{"unparseable returned unchanged", "://bad", "://bad"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := transformURLToSSH(tt.in); got != tt.want {
				t.Fatalf("transformURLToSSH(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}

	g := NewGIT("https://github.com/acme/repo", "/tmp/repo", true)
	if g.RepoURL != "git@github.com:acme/repo.git" || g.LocalPath != "/tmp/repo" || !g.DryRun {
		t.Fatalf("NewGIT returned unexpected wrapper: %#v", g)
	}

	withToken := NewGITWithToken("github.com/acme/repo.git", "/tmp/repo", false, "tok")
	if withToken.RepoURL != "https://github.com/acme/repo.git" || withToken.Token != "tok" {
		t.Fatalf("NewGITWithToken returned unexpected wrapper: %#v", withToken)
	}
	auth, err := withToken.getAuth()
	if err != nil {
		t.Fatalf("getAuth with token: %v", err)
	}
	if auth.Name() != "http-basic-auth" {
		t.Fatalf("auth name = %q, want http-basic-auth", auth.Name())
	}
}

func TestMapCloneErrorNormalizesSentinels(t *testing.T) {
	tests := []struct {
		err  error
		want error
	}{
		{transport.ErrRepositoryNotFound, ErrRepoNotFound},
		{transport.ErrEmptyRemoteRepository, ErrRepoEmpty},
		{transport.ErrAuthorizationFailed, ErrAuthFailed},
		{transport.ErrAuthenticationRequired, ErrAuthFailed},
	}
	for _, tt := range tests {
		got := mapCloneError("repo", tt.err)
		if !errors.Is(got, tt.want) {
			t.Fatalf("mapCloneError(%v) = %v, want wrapping %v", tt.err, got, tt.want)
		}
	}
	if got := mapCloneError("repo", errors.New("boom")); !strings.Contains(got.Error(), "failed to clone repository") {
		t.Fatalf("generic mapCloneError = %v", got)
	}
}

func TestCloneHeadDirtyResetAndFileExists(t *testing.T) {
	repo, branch, _, sha2 := makeFixtureRepo(t)
	cloneDir := filepath.Join(t.TempDir(), "clone")
	g := NewGIT("file://"+repo, cloneDir, false)
	if err := g.Clone(context.Background(), branch, true); err != nil {
		t.Fatalf("Clone: %v", err)
	}
	if g.Repo == nil {
		t.Fatal("Clone did not set Repo")
	}
	if !g.FileExists("a.txt") {
		t.Fatal("FileExists(a.txt) = false")
	}
	if !g.isCorrectRepo() {
		t.Fatal("isCorrectRepo = false for freshly cloned repository")
	}
	head, err := g.HeadSHA()
	if err != nil {
		t.Fatalf("HeadSHA: %v", err)
	}
	if head != sha2 {
		t.Fatalf("HeadSHA = %s, want branch tip %s", head, sha2)
	}

	if err := os.WriteFile(filepath.Join(cloneDir, "scratch.txt"), []byte("dirty"), 0644); err != nil {
		t.Fatalf("write scratch: %v", err)
	}
	dirty, err := g.IsDirty()
	if err != nil {
		t.Fatalf("IsDirty: %v", err)
	}
	if !dirty {
		t.Fatal("IsDirty = false after writing an untracked file")
	}
	if err := g.ResetAndRestoreChanges(); err != nil {
		t.Fatalf("ResetAndRestoreChanges: %v", err)
	}
	if g.FileExists("scratch.txt") {
		t.Fatal("ResetAndRestoreChanges did not remove untracked file")
	}

	if err := g.Checkout(sha2); err != nil {
		t.Fatalf("Checkout cloned head: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(cloneDir, "a.txt"))
	if err != nil {
		t.Fatalf("read a.txt: %v", err)
	}
	if string(data) != "v2" {
		t.Fatalf("a.txt after Checkout = %q, want v2", data)
	}

	dry := &GIT{RepoURL: g.RepoURL, LocalPath: cloneDir, Repo: g.Repo, DryRun: true}
	if err := dry.Push(); err != nil {
		t.Fatalf("dry-run Push: %v", err)
	}
	if err := dry.AddAndCommit("noop"); err != nil {
		t.Fatalf("dry-run AddAndCommit: %v", err)
	}
}

func TestCopyFilesClearRepoContentsAndBootstrap(t *testing.T) {
	tmp := t.TempDir()
	src := filepath.Join(tmp, "template")
	dst := filepath.Join(tmp, "repo")
	for _, dir := range []string{
		filepath.Join(src, "nested"),
		filepath.Join(src, "variable-template"),
		filepath.Join(dst, ".git"),
		filepath.Join(dst, "old"),
	} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	files := map[string]string{
		filepath.Join(src, "main.tf"):                 "template-main",
		filepath.Join(src, "nested", "values.tfvars"): "values",
		filepath.Join(src, "variable-template", "x"):  "ignored",
		filepath.Join(dst, "old", "file.txt"):         "old",
		filepath.Join(dst, "keep.tf"):                 "keep",
	}
	for path, body := range files {
		if err := os.WriteFile(path, []byte(body), 0644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}

	g := &GIT{LocalPath: dst, DryRun: true}
	if err := g.CopyFiles(src, dst, []string{"variable-template"}); err != nil {
		t.Fatalf("CopyFiles: %v", err)
	}
	if !g.FileExists("nested/values.tfvars") {
		t.Fatal("CopyFiles did not copy nested file")
	}
	if g.FileExists("variable-template/x") {
		t.Fatal("CopyFiles copied ignored directory")
	}

	if err := g.ClearRepoContents(); err != nil {
		t.Fatalf("ClearRepoContents: %v", err)
	}
	if !g.FileExists(".git") {
		t.Fatal("ClearRepoContents removed .git")
	}
	if g.FileExists("old/file.txt") || g.FileExists("keep.tf") {
		t.Fatal("ClearRepoContents left non-.git content behind")
	}

	repo, branch, _, _ := makeFixtureRepo(t)
	cloneDir := filepath.Join(t.TempDir(), "clone")
	client := NewGIT("file://"+repo, cloneDir, true)
	if err := client.Clone(context.Background(), branch, true); err != nil {
		t.Fatalf("Clone for bootstrap: %v", err)
	}
	template := &GIT{LocalPath: src}
	if err := client.Bootstrap(template, map[string]string{"nested/values.tfvars": "env/prod.tfvars"}, false, utils.NewLogger(nil, "")); err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	for _, want := range []string{"main.tf", "nested/values.tfvars", "env/prod.tfvars"} {
		if !client.FileExists(want) {
			t.Fatalf("Bootstrap did not create %s", want)
		}
	}
}

func TestRepositoryMethodsRejectUninitializedRepo(t *testing.T) {
	g := &GIT{RepoURL: "file:///tmp/repo", LocalPath: t.TempDir()}
	for name, err := range map[string]error{
		"Checkout":               g.Checkout("0123456789abcdef0123456789abcdef01234567"),
		"HeadSHA":                func() error { _, err := g.HeadSHA(); return err }(),
		"Pull":                   g.Pull(context.Background()),
		"Push":                   g.Push(),
		"AddAndCommit":           g.AddAndCommit("msg"),
		"ResetAndRestoreChanges": g.ResetAndRestoreChanges(),
		"IsDirty":                func() error { _, err := g.IsDirty(); return err }(),
	} {
		if err == nil || !strings.Contains(err.Error(), "repository not initialized") {
			t.Fatalf("%s error = %v, want repository not initialized", name, err)
		}
	}
}
