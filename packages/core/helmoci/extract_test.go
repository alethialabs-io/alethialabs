// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package helmoci

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestExtract_HappyPath is the baseline: a normal packaged chart lands intact, and the returned
// directory is the one `helm template` should be pointed at.
func TestExtract_HappyPath(t *testing.T) {
	root := t.TempDir()
	tgz := tarGzOf(t, map[string]string{
		"demo/Chart.yaml":            "apiVersion: v2\nname: demo\nversion: 1.0.0\n",
		"demo/values.yaml":           "replicas: 1\n",
		"demo/templates/cm.yaml":     "kind: ConfigMap\n",
		"demo/charts/sub/Chart.yaml": "name: sub\n",
	})

	dir, err := extractChartTarGz(bytes.NewReader(tgz), root)
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if filepath.Base(dir) != "demo" {
		t.Fatalf("chart dir = %q, want it to end in demo", dir)
	}
	assertFile(t, filepath.Join(dir, "Chart.yaml"), "name: demo")
	assertFile(t, filepath.Join(dir, "templates", "cm.yaml"), "ConfigMap")
	assertFile(t, filepath.Join(dir, "charts", "sub", "Chart.yaml"), "name: sub")
}

// TestExtract_FilePermissions checks extracted files are owner-only. A chart's values can carry
// secrets, matching how the scan stage writes its own values file.
func TestExtract_FilePermissions(t *testing.T) {
	root := t.TempDir()
	tgz := tarGzOf(t, map[string]string{"demo/Chart.yaml": "name: demo\n"})

	dir, err := extractChartTarGz(bytes.NewReader(tgz), root)
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, "Chart.yaml"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("Chart.yaml mode = %o, want 600", perm)
	}
}

// TestExtract_RejectsHostileArchives is the core safety table. Each case is an archive shape that a
// naive extractor would happily write outside its destination, or that would point the renderer at
// a host file. All must be refused outright — a chart we cannot extract faithfully is a chart whose
// scan verdict would be a lie, so skipping the entry is not an acceptable alternative.
func TestExtract_RejectsHostileArchives(t *testing.T) {
	tests := []struct {
		name    string
		build   func(t *testing.T) []byte
		wantErr string
	}{
		{
			name:    "parent traversal",
			wantErr: "traverses upward",
			build: func(t *testing.T) []byte {
				return tarGzWithHeaders(t, []*tar.Header{
					{Name: "demo/../../escape.txt", Mode: 0o644, Size: 4, Typeflag: tar.TypeReg},
				}, []string{"pwn!"})
			},
		},
		{
			name:    "absolute path",
			wantErr: "absolute path",
			build: func(t *testing.T) []byte {
				return tarGzWithHeaders(t, []*tar.Header{
					{Name: "/etc/cron.d/pwn", Mode: 0o644, Size: 4, Typeflag: tar.TypeReg},
				}, []string{"pwn!"})
			},
		},
		{
			name:    "symlink entry",
			wantErr: "unsupported type",
			build: func(t *testing.T) []byte {
				return tarGzWithHeaders(t, []*tar.Header{
					{Name: "demo/Chart.yaml", Mode: 0o644, Size: 11, Typeflag: tar.TypeReg},
					{Name: "demo/link", Mode: 0o777, Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"},
				}, []string{"name: demo\n", ""})
			},
		},
		{
			name:    "hardlink entry",
			wantErr: "unsupported type",
			build: func(t *testing.T) []byte {
				return tarGzWithHeaders(t, []*tar.Header{
					{Name: "demo/Chart.yaml", Mode: 0o644, Size: 11, Typeflag: tar.TypeReg},
					{Name: "demo/hard", Mode: 0o644, Typeflag: tar.TypeLink, Linkname: "demo/Chart.yaml"},
				}, []string{"name: demo\n", ""})
			},
		},
		{
			name:    "fifo entry",
			wantErr: "unsupported type",
			build: func(t *testing.T) []byte {
				return tarGzWithHeaders(t, []*tar.Header{
					{Name: "demo/pipe", Mode: 0o644, Typeflag: tar.TypeFifo},
				}, nil)
			},
		},
		{
			name:    "multiple top-level directories",
			wantErr: "multiple top-level directories",
			build: func(t *testing.T) []byte {
				return tarGzOf(t, map[string]string{
					"demo/Chart.yaml":  "name: demo\n",
					"other/Chart.yaml": "name: other\n",
				})
			},
		},
		{
			name:    "no Chart.yaml",
			wantErr: "not a packaged Helm chart",
			build: func(t *testing.T) []byte {
				return tarGzOf(t, map[string]string{"demo/values.yaml": "a: 1\n"})
			},
		},
		{
			name:    "empty archive",
			wantErr: "empty",
			build: func(t *testing.T) []byte {
				return tarGzOf(t, map[string]string{})
			},
		},
		{
			name:    "not gzip",
			wantErr: "not gzip",
			build: func(t *testing.T) []byte {
				return []byte("this is not a gzip stream")
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			_, err := extractChartTarGz(bytes.NewReader(tc.build(t)), root)
			if err == nil {
				t.Fatalf("extract succeeded, want error containing %q", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %v, want it to contain %q", err, tc.wantErr)
			}
			// Nothing may have escaped the destination.
			if _, statErr := os.Stat(filepath.Join(filepath.Dir(root), "escape.txt")); statErr == nil {
				t.Fatal("archive wrote a file outside the destination")
			}
		})
	}
}

// TestExtract_RejectsTooManyEntries bounds the file count, so a tarball of a million tiny files
// cannot exhaust inodes or wall-clock inside a scan.
func TestExtract_RejectsTooManyEntries(t *testing.T) {
	hdrs := make([]*tar.Header, 0, maxEntries+1)
	bodies := make([]string, 0, maxEntries+1)
	for i := 0; i <= maxEntries; i++ {
		hdrs = append(hdrs, &tar.Header{
			Name: filepath.Join("demo", "f", strings.Repeat("a", 1)+itoa(i)),
			Mode: 0o644, Size: 1, Typeflag: tar.TypeReg,
		})
		bodies = append(bodies, "x")
	}
	_, err := extractChartTarGz(bytes.NewReader(tarGzWithHeaders(t, hdrs, bodies)), t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "more than") {
		t.Fatalf("error = %v, want an entry-count failure", err)
	}
}

// TestExtract_RejectsDecompressionBomb proves the uncompressed-size budget bites. The compressed
// layer is already bounded, but gzip ratios are not — this is the guard that matters.
func TestExtract_RejectsDecompressionBomb(t *testing.T) {
	// A single highly-compressible entry declaring more than the uncompressed budget.
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	size := int64(maxUncompressedBytes) + 1
	if err := tw.WriteHeader(&tar.Header{Name: "demo/big.bin", Mode: 0o644, Size: size, Typeflag: tar.TypeReg}); err != nil {
		t.Fatalf("header: %v", err)
	}
	chunk := make([]byte, 1<<20)
	for written := int64(0); written < size; {
		n := int64(len(chunk))
		if size-written < n {
			n = size - written
		}
		if _, err := tw.Write(chunk[:n]); err != nil {
			t.Fatalf("write: %v", err)
		}
		written += n
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("close gzip: %v", err)
	}

	_, err := extractChartTarGz(bytes.NewReader(buf.Bytes()), t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "expands beyond") {
		t.Fatalf("error = %v, want an expansion-budget failure", err)
	}
}

// TestSafeEntryName covers the normalizer directly, including the entries a well-formed archive
// legitimately contains.
func TestSafeEntryName(t *testing.T) {
	tests := []struct {
		raw     string
		want    string
		wantErr bool
	}{
		{raw: "demo/Chart.yaml", want: "demo/Chart.yaml"},
		{raw: "./demo/Chart.yaml", want: "demo/Chart.yaml"},
		{raw: "demo/templates/", want: "demo/templates"},
		{raw: "./", want: ""},
		{raw: ".", want: ""},
		{raw: "/absolute", wantErr: true},
		{raw: "demo/../escape", wantErr: true},
		{raw: "../escape", wantErr: true},
		{raw: `demo\..\escape`, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.raw, func(t *testing.T) {
			got, err := safeEntryName(tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("safeEntryName(%q) = %q, want an error", tc.raw, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("safeEntryName(%q): %v", tc.raw, err)
			}
			if got != tc.want {
				t.Fatalf("safeEntryName(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// TestWithinRoot locks the containment belt that backs safeEntryName's braces.
func TestWithinRoot(t *testing.T) {
	if !withinRoot("/a/b", "/a/b/c") || !withinRoot("/a/b", "/a/b") {
		t.Fatal("paths inside root reported as outside")
	}
	if withinRoot("/a/b", "/a/c") || withinRoot("/a/b", "/a") {
		t.Fatal("paths outside root reported as inside")
	}
}

// itoa is a tiny helper so the entry-count fixture doesn't import strconv.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
