// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package update implements the CLI's "a newer version is available" notice. It
// mirrors the runner-release model: the control plane publishes releases to the
// cli_releases table (exposed at /api/releases/cli) and the CLI polls it at most
// once a day, caching the result next to the other CLI config. The check never
// blocks a command and is easy to silence (ALETHIA_NO_UPDATE_CHECK, CI, or a
// non-interactive stdout).
package update

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
)

const checkInterval = 24 * time.Hour

// cache is the persisted result of the last update check.
type cache struct {
	LastCheck    time.Time `json:"last_check"`
	Latest       string    `json:"latest_version"`
	URL          string    `json:"github_release_url"`
	MinSupported string    `json:"min_supported_version"`
}

// release is the subset of GET /api/releases/cli the CLI consumes.
type release struct {
	Version             string  `json:"version"`
	GithubReleaseURL    *string `json:"github_release_url"`
	MinSupportedVersion *string `json:"min_supported_version"`
}

func cachePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "alethia", "update-check.json"), nil
}

func loadCache() cache {
	var c cache
	path, err := cachePath()
	if err != nil {
		return c
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return c
	}
	_ = json.Unmarshal(data, &c)
	return c
}

func saveCache(c cache) {
	path, err := cachePath()
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	data, err := json.Marshal(c)
	if err != nil {
		return
	}
	_ = os.WriteFile(path, data, 0o600)
}

// isInteractive reports whether stdout is a terminal (so we never inject the
// notice into piped/redirected output).
func isInteractive() bool {
	fi, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

func fetchLatest(origin string) (*release, error) {
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := client.Get(strings.TrimRight(origin, "/") + "/api/releases/cli")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	var r release
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, err
	}
	return &r, nil
}

// CheckAndNotify prints a one-line upgrade hint when a newer release exists. It
// is safe to call unconditionally — every disabling condition is handled here.
func CheckAndNotify(current string) {
	if current == "" || current == "dev" {
		return
	}
	if os.Getenv("ALETHIA_NO_UPDATE_CHECK") != "" || os.Getenv("CI") != "" {
		return
	}
	if !isInteractive() {
		return
	}
	origin := os.Getenv("ALETHIA_WEB_ORIGIN")
	if origin == "" {
		return
	}

	c := loadCache()
	if time.Since(c.LastCheck) > checkInterval {
		// Back off on the timestamp regardless of outcome so a flaky/offline
		// control plane never turns into a check on every invocation.
		c.LastCheck = time.Now()
		if r, err := fetchLatest(origin); err == nil {
			c.Latest = r.Version
			c.URL = deref(r.GithubReleaseURL)
			c.MinSupported = deref(r.MinSupportedVersion)
		}
		saveCache(c)
	}

	notify(current, c)
}

// CachedLatest returns the last-known latest version (for `alethia version`).
func CachedLatest() (string, bool) {
	c := loadCache()
	if c.Latest == "" {
		return "", false
	}
	return c.Latest, true
}

func notify(current string, c cache) {
	notifyTo(os.Stderr, current, c)
}

// notifyTo writes the upgrade notice to w when c.Latest is newer than current.
// Split out from notify so the formatting/threshold logic is unit-testable.
func notifyTo(w io.Writer, current string, c cache) {
	if c.Latest == "" || compareSemver(c.Latest, current) <= 0 {
		return
	}

	hint := ui.MutedStyle.Render("Run `brew upgrade alethia`")
	if c.URL != "" {
		hint += ui.MutedStyle.Render(" · " + c.URL)
	}

	fmt.Fprintln(w)
	if c.MinSupported != "" && compareSemver(c.MinSupported, current) > 0 {
		fmt.Fprintln(w, ui.StrongStyle.Render(
			fmt.Sprintf("%s This alethia version is below the minimum supported (%s).", ui.SymbolPoint, c.MinSupported)))
	} else {
		fmt.Fprintln(w, ui.StrongStyle.Render(
			fmt.Sprintf("%s A new version of alethia is available: %s → %s", ui.SymbolArrow, current, c.Latest)))
	}
	fmt.Fprintln(w, "  "+hint)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// compareSemver compares dotted versions, ignoring any pre-release suffix
// (e.g. "1.2.0-next"). Returns -1, 0, or 1.
func compareSemver(a, b string) int {
	pa, pb := parseSemver(a), parseSemver(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

func parseSemver(v string) [3]int {
	v = strings.TrimPrefix(v, "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	var out [3]int
	for i, part := range strings.SplitN(v, ".", 3) {
		if i > 2 {
			break
		}
		n, _ := strconv.Atoi(strings.TrimSpace(part))
		out[i] = n
	}
	return out
}
