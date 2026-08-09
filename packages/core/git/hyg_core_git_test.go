// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package git

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// hygCoreGitPathThroughAFile builds a path whose PARENT component is a regular file, so
// os.Stat on it fails with a real ENOTDIR — an error that is neither nil nor ErrNotExist.
// It asserts that precondition itself, because a setup that produced a plain ENOENT would
// make the assertions below pass against the unfixed code and prove nothing.
func hygCoreGitPathThroughAFile(t *testing.T) string {
	t.Helper()
	blocker := filepath.Join(t.TempDir(), "notadir")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	through := filepath.Join(blocker, "child")
	_, err := os.Stat(through)
	if err == nil {
		t.Fatalf("precondition: os.Stat(%q) succeeded, want an ENOTDIR failure", through)
	}
	if os.IsNotExist(err) {
		t.Fatalf("precondition: os.Stat(%q) = %v, want an error that is NOT ErrNotExist", through, err)
	}
	return through
}

// TestHygCoreGitClearRepoContentsReturnsStatFailure pins #2048: a stat failure other than
// ENOENT used to leave info nil while only os.IsNotExist(err) was checked, so !info.IsDir()
// dereferenced a nil os.FileInfo and killed the process. The guard must return an error
// naming the stat failure instead.
func TestHygCoreGitClearRepoContentsReturnsStatFailure(t *testing.T) {
	g := &GIT{LocalPath: hygCoreGitPathThroughAFile(t)}

	err := g.ClearRepoContents()
	if err == nil {
		t.Fatal("ClearRepoContents on an unstattable local path = nil, want an error")
	}
	if !strings.Contains(err.Error(), "failed to stat local path") {
		t.Fatalf("error = %v, want the stat failure to be named", err)
	}
}

// TestHygCoreGitFileExistsRejectsAmbiguousStatError pins #2090: FileExists returned
// !os.IsNotExist(err), so an ENOTDIR (or EACCES) read as "the file is there" and Bootstrap
// logged "file exists and will not overwrite it!" for a structurally impossible destination.
// Only a successful stat may report true.
func TestHygCoreGitFileExistsRejectsAmbiguousStatError(t *testing.T) {
	through := hygCoreGitPathThroughAFile(t)
	g := &GIT{LocalPath: filepath.Dir(through)}

	if g.FileExists(filepath.Base(through)) {
		t.Fatalf("FileExists(%q) = true on an ENOTDIR stat, want false", through)
	}

	// Positive control: a real file under a real directory still reports true, and a
	// plainly absent one still reports false.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "main.tf"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	ok := &GIT{LocalPath: dir}
	if !ok.FileExists("main.tf") {
		t.Fatal("FileExists(main.tf) = false for a file that is present")
	}
	if ok.FileExists("absent.tf") {
		t.Fatal("FileExists(absent.tf) = true for a file that is not there")
	}
}
