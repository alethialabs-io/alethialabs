// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package helmoci

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const (
	// maxUncompressedBytes caps what a chart tarball may expand to. The compressed layer is already
	// bounded, but gzip ratios are unbounded — this is the decompression-bomb guard.
	maxUncompressedBytes = 256 << 20 // 256 MiB
	// maxEntries bounds the file count, so a tarball of a million empty files cannot exhaust inodes
	// or wall-clock inside a scan.
	maxEntries = 20000
)

// extractChartTarGz unpacks a packaged Helm chart (`.tgz`) beneath root and returns the directory
// holding Chart.yaml. A packaged chart always has exactly one top-level directory named for the
// chart, which is the directory `helm template` expects.
//
// Extraction is fail-closed by construction. The archive is untrusted input from a third-party
// registry, so anything that is not a plain file or a directory landing strictly inside root is a
// hard error rather than a skipped entry: symlinks and hardlinks (which could redirect a later
// write, or point the renderer at a host file), device/FIFO nodes, absolute paths, and `..`
// traversal are all refused. Refusing beats skipping — a chart we cannot extract faithfully is a
// chart whose scan verdict would be a lie.
func extractChartTarGz(r io.Reader, root string) (string, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return "", fmt.Errorf("chart layer is not gzip: %w", err)
	}
	defer func() { _ = gz.Close() }()

	// Resolve root once so the containment check compares real paths (the job workdir lives under
	// /var/folders on macOS, which is itself a symlink).
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("resolve chart dir: %w", err)
	}

	tr := tar.NewReader(gz)
	var (
		topLevel  string
		written   int64
		entries   int
		sawChart  bool
		chartYAML = "Chart.yaml"
	)

	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", fmt.Errorf("read chart archive: %w", err)
		}

		entries++
		if entries > maxEntries {
			return "", fmt.Errorf("chart archive has more than %d entries", maxEntries)
		}

		name, err := safeEntryName(hdr.Name)
		if err != nil {
			return "", err
		}
		if name == "" {
			continue // the archive's own "./" entry
		}

		// Every path in a packaged chart is <chart-name>/…; a second top-level name means this is
		// not a packaged chart and `helm template` would not know which directory to render.
		top := strings.SplitN(name, "/", 2)[0]
		if topLevel == "" {
			topLevel = top
		} else if top != topLevel {
			return "", fmt.Errorf("chart archive has multiple top-level directories (%q and %q)", topLevel, top)
		}
		if name == path.Join(topLevel, chartYAML) {
			sawChart = true
		}

		target := filepath.Join(realRoot, filepath.FromSlash(name))
		if !withinRoot(realRoot, target) {
			return "", fmt.Errorf("chart archive entry escapes the chart directory: %q", hdr.Name)
		}

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return "", fmt.Errorf("create %q: %w", name, err)
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return "", fmt.Errorf("create parent of %q: %w", name, err)
			}
			n, err := writeEntry(target, tr, maxUncompressedBytes-written)
			if err != nil {
				return "", fmt.Errorf("write %q: %w", name, err)
			}
			written += n
		default:
			// Symlink, hardlink, char/block device, FIFO — none of which a renderable chart needs.
			return "", fmt.Errorf("chart archive entry %q has unsupported type %q (only regular files and directories are allowed)",
				hdr.Name, string(rune(hdr.Typeflag)))
		}
	}

	if topLevel == "" {
		return "", errors.New("chart archive is empty")
	}
	if !sawChart {
		return "", fmt.Errorf("chart archive has no %s/%s — it is not a packaged Helm chart", topLevel, chartYAML)
	}
	return filepath.Join(realRoot, topLevel), nil
}

// safeEntryName normalizes a tar entry path and rejects the shapes that let an archive write outside
// its destination: absolute paths, Windows-style volume/backslash paths, and any `..` component.
// It returns "" for the archive's own root entry, which callers skip.
func safeEntryName(raw string) (string, error) {
	name := strings.TrimPrefix(strings.ReplaceAll(raw, `\`, "/"), "./")
	name = strings.Trim(name, "/")
	if name == "" || name == "." {
		return "", nil
	}
	if path.IsAbs(raw) || strings.HasPrefix(raw, "/") {
		return "", fmt.Errorf("chart archive entry has an absolute path: %q", raw)
	}
	if filepath.VolumeName(raw) != "" {
		return "", fmt.Errorf("chart archive entry has a volume path: %q", raw)
	}
	for _, seg := range strings.Split(name, "/") {
		if seg == ".." {
			return "", fmt.Errorf("chart archive entry traverses upward: %q", raw)
		}
	}
	return path.Clean(name), nil
}

// withinRoot reports whether target is root itself or lies beneath it — the belt to
// safeEntryName's braces, so a path that survives normalization still cannot land outside.
func withinRoot(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// writeEntry copies one archive entry to disk under a remaining-bytes budget, so the total
// uncompressed size stays bounded no matter what the gzip stream claims. Files are owner-only: a
// chart's values can carry secrets, matching how the scan writes its values file.
func writeEntry(target string, r io.Reader, remaining int64) (int64, error) {
	if remaining <= 0 {
		return 0, fmt.Errorf("chart archive expands beyond %d bytes", int64(maxUncompressedBytes))
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC|os.O_EXCL, 0o600)
	if err != nil {
		return 0, err
	}
	defer func() { _ = f.Close() }()

	// LimitReader with remaining+1 lets us tell "exactly at the budget" from "over it".
	n, err := io.Copy(f, io.LimitReader(r, remaining+1))
	if err != nil {
		return n, err
	}
	if n > remaining {
		return n, fmt.Errorf("chart archive expands beyond %d bytes", int64(maxUncompressedBytes))
	}
	return n, nil
}
