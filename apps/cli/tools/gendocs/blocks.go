// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"io/fs"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// The marker convention. A block opens with `{/* gendocs: <name> <argument> */}` on a line of its
// own and closes with `{/* /gendocs */}` on a later line of its own. Both are MDX comments, so the
// page renders the same with or without them, and the generator owns exactly the lines between.
const (
	openPrefix = "{/* gendocs: "
	openSuffix = " */}"
	closeLine  = "{/* /gendocs */}"
)

// page is one docs page that carries at least one generated block.
type page struct {
	// Path is the file's path, as the caller named the directory it lives in.
	Path string
	// Committed is the file as it is now.
	Committed string
	// Generated is the file with every block re-rendered.
	Generated string
}

// generatePages re-renders every generated block of every .mdx file under fsys and returns the
// pages that carry one, sorted by path. base is prefixed to each page's path for the caller.
//
// It refuses rather than guesses: an opening marker with no closing one, a closing marker with no
// opening one, a block name nothing renders, and a directory in which no page carries a block at
// all. The last is the vacuity refusal: a generator that finds nothing to generate must not read
// the same as one that found everything current.
func generatePages(fsys fs.FS, base string, src source) ([]page, error) {
	var pages []page
	err := fs.WalkDir(fsys, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || path.Ext(name) != ".mdx" {
			return nil
		}
		raw, err := fs.ReadFile(fsys, name)
		if err != nil {
			return err
		}
		committed := string(raw)
		if !strings.Contains(committed, openPrefix) && !strings.Contains(committed, closeLine) {
			return nil
		}
		generated, err := rewrite(committed, src)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		pages = append(pages, page{Path: filepath.Join(base, filepath.FromSlash(name)), Committed: committed, Generated: generated})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(pages) == 0 {
		return nil, fmt.Errorf("no page under %s carries a %q block; the generator would check nothing", base, strings.TrimSpace(openPrefix))
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].Path < pages[j].Path })
	return pages, nil
}

// rewrite returns a page with the body of every generated block replaced by its rendering.
func rewrite(text string, src source) (string, error) {
	lines := strings.Split(text, "\n")
	var out []string
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		trimmed := strings.TrimSpace(line)
		if trimmed == closeLine {
			return "", fmt.Errorf("line %d closes a generated block that was never opened", i+1)
		}
		spec, ok := openMarker(trimmed)
		if !ok {
			out = append(out, line)
			continue
		}
		end := -1
		for j := i + 1; j < len(lines); j++ {
			next := strings.TrimSpace(lines[j])
			if next == closeLine {
				end = j
				break
			}
			if _, nested := openMarker(next); nested {
				return "", fmt.Errorf("line %d opens a block inside the block opened on line %d", j+1, i+1)
			}
		}
		if end == -1 {
			return "", fmt.Errorf("line %d opens %q and nothing closes it with %s", i+1, spec, closeLine)
		}
		body, err := render(spec, src)
		if err != nil {
			return "", fmt.Errorf("line %d: %w", i+1, err)
		}
		// A blank line on each side of the body keeps MDX reading a table or a fence as one.
		out = append(out, line, "")
		out = append(out, strings.Split(strings.TrimRight(body, "\n"), "\n")...)
		out = append(out, "", lines[end])
		i = end
	}
	return strings.Join(out, "\n"), nil
}

// openMarker reports whether a trimmed line opens a block, and returns what it names.
func openMarker(trimmed string) (string, bool) {
	if !strings.HasPrefix(trimmed, openPrefix) || !strings.HasSuffix(trimmed, openSuffix) {
		return "", false
	}
	spec := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(trimmed, openPrefix), openSuffix))
	return spec, spec != ""
}
