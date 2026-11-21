// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/designfile"
	"gopkg.in/yaml.v3"
)

// sample is a manifest with one environment, the smallest a command authors.
func sample() *Manifest {
	return &Manifest{
		Project:      "boutique",
		Cloud:        Cloud{Account: "prod-account", Region: "eu-west-1"},
		Environments: []Environment{{Name: "prod", Stage: "production", Placement: "dedicated"}},
	}
}

// A file the CLI authors opens with the line that names its schema, and the rest of it is exactly
// what the shared renderer writes, so it reads back as the manifest it was written from.
func TestWrite_OpensWithTheSchemaComment(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	if err := Write(path, sample(), false); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	body, err := Render(sample())
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != SchemaComment+"\n"+string(body) {
		t.Errorf("the file is not the schema comment over the rendered manifest:\n%s", got)
	}
	if SchemaComment != designfile.SchemaComment || !strings.HasPrefix(SchemaComment, "# yaml-language-server: $schema=") {
		t.Errorf("the comment is not the one export writes: %q", SchemaComment)
	}
	back, err := Load(path)
	if err != nil {
		t.Fatalf("the file does not read back: %v", err)
	}
	if back.Project != "boutique" || len(back.Environments) != 1 || back.Environments[0].Name != "prod" {
		t.Errorf("the file read back as another manifest: %+v", back)
	}
}

// An existing file is refused unless the caller asked to replace it, and is left as it was.
func TestWrite_RefusesToReplaceAFileUnasked(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	if err := os.WriteFile(path, []byte("project: kept\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := Write(path, sample(), false)
	if err == nil || !strings.Contains(err.Error(), "already exists") || !strings.Contains(err.Error(), "--force") {
		t.Fatalf("an existing file was not refused with the way past it: %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "project: kept\n" {
		t.Errorf("a refused write changed the file: %q", got)
	}
	if err := Write(path, sample(), true); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); !strings.HasPrefix(string(got), SchemaComment+"\nproject: boutique\n") {
		t.Errorf("overwrite did not replace the file: %q", got)
	}
}

// A manifest that cannot be rendered, and a path that cannot be written, are both reported.
func TestWrite_ReportsWhatItCannotWrite(t *testing.T) {
	dir := t.TempDir()
	if err := Write(filepath.Join(dir, "no", "such", FileName), sample(), false); err == nil {
		t.Error("a path that cannot be written was not reported")
	}
	broken := sample()
	broken.Environments[0].Components = Components{{
		Kind: "cluster", Entries: []Component{{Fields: map[string]any{"bad": unrenderable{}}}},
	}}
	path := filepath.Join(dir, FileName)
	if err := Write(path, broken, false); err == nil {
		t.Error("a manifest that cannot be rendered was not reported")
	}
	if _, err := os.Stat(path); err == nil {
		t.Error("a manifest that cannot be rendered still left a file behind")
	}
}

// unrenderable is a value YAML refuses to encode.
type unrenderable struct{}

// MarshalYAML refuses, the way a value with no YAML form does.
func (unrenderable) MarshalYAML() (any, error) { return nil, os.ErrInvalid }

var _ yaml.Marshaler = unrenderable{}
