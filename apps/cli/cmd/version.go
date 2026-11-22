// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/update"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/spf13/cobra"
)

// noUpdateCheckEnv silences every lookup of the latest release, the one in `version` included.
const noUpdateCheckEnv = "ALETHIA_NO_UPDATE_CHECK"

// buildUnknown is what a build fact reads as when the binary does not carry it.
const buildUnknown = "unknown"

// readBuildInfo reads the build facts the Go toolchain stamped into the binary. It is a variable
// so a test can supply a build that carries a commit, which a test binary never does.
var readBuildInfo = debug.ReadBuildInfo

// VersionInfo is what `alethia version` reports. Every key is always present; a fact the binary
// does not carry reads "unknown", and Latest is "" when the latest release could not be read.
type VersionInfo struct {
	// Version is the release this binary was built as, without a leading v. "dev" for a local build.
	Version string `json:"version"`
	// Commit is the source revision the binary was built from.
	Commit string `json:"commit"`
	// Date is when that revision was committed, in RFC 3339.
	Date string `json:"date"`
	// Go is the toolchain that built it.
	Go string `json:"go"`
	// OS and Arch are the platform it was built for.
	OS   string `json:"os"`
	Arch string `json:"arch"`
	// Latest is the newest release the control plane publishes, or "".
	Latest string `json:"latest"`
	// UpdateAvailable reports that Latest is newer than Version.
	UpdateAvailable bool `json:"update_available"`
}

// versionColumns are the csv columns of a VersionInfo.
var versionColumns = []string{"version", "commit", "date", "go", "os", "arch", "latest", "update_available"}

// Table returns the version as one csv row.
func (v VersionInfo) Table() ui.TableSpec {
	return ui.TableSpec{
		Columns: versionColumns,
		Rows: [][]string{{
			v.Version, v.Commit, v.Date, v.Go, v.OS, v.Arch, v.Latest, strconv.FormatBool(v.UpdateAvailable),
		}},
	}
}

// buildVersionInfo collects the build facts of the running binary. The commit and its date come
// from the revision the toolchain recorded at build time, so they need no flag in the release
// build to be right.
func buildVersionInfo() VersionInfo {
	info := VersionInfo{
		Version: version.Version,
		Commit:  buildUnknown,
		Date:    buildUnknown,
		Go:      runtime.Version(),
		OS:      runtime.GOOS,
		Arch:    runtime.GOARCH,
	}
	build, ok := readBuildInfo()
	if !ok {
		return info
	}
	for _, setting := range build.Settings {
		switch setting.Key {
		case "vcs.revision":
			info.Commit = setting.Value
		case "vcs.time":
			info.Date = setting.Value
		}
	}
	return info
}

// latestRelease returns the newest release version known for origin: the control plane's answer,
// or the last one cached when it cannot be asked. A development build and a run with the update
// check silenced look nothing up.
func latestRelease(current, origin string) string {
	if current == "" || current == "dev" || os.Getenv(noUpdateCheckEnv) != "" {
		return ""
	}
	if release, err := update.FetchLatest(origin); err == nil {
		return release.Version
	}
	if cached, ok := update.CachedLatest(); ok {
		return cached
	}
	return ""
}

// renderVersion writes the version for a person. The first line is `alethia v<version>` and
// nothing else: `alethia update` reads it back from a freshly installed binary.
func renderVersion(w io.Writer, v VersionInfo) {
	fmt.Fprintf(w, "alethia v%s\n", v.Version)
	commit := v.Commit
	if len(commit) > 12 {
		commit = commit[:12]
	}
	fmt.Fprintf(w, "commit %s of %s · %s %s/%s\n", commit, v.Date, v.Go, v.OS, v.Arch)
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the version of this CLI, with the commit it was built from",
	Long: `Print what this binary is: its release version, the commit it was built from, when that
commit was made, the Go toolchain and the platform. Use it in a bug report, or with
--output json in a script that needs to know which CLI it is driving.

It also asks the control plane for the newest release and says so on stderr when this one is
older. Set ALETHIA_NO_UPDATE_CHECK=1 to skip that request.`,
	Args:        cobra.NoArgs,
	Annotations: map[string]string{skipUpdateNoticeAnnotation: "true"},
	Run: func(cmd *cobra.Command, _ []string) {
		_ = outputFormat(cmd)
		info := buildVersionInfo()
		info.Latest = latestRelease(info.Version, WebOrigin())
		info.UpdateAvailable = update.IsNewer(info.Latest, info.Version)
		firstRunEmit(info, func(w io.Writer) { renderVersion(w, info) })
		if info.UpdateAvailable {
			printer.Note(fmt.Sprintf("v%s is available. Run `alethia update` to install it.", info.Latest))
		}
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)
}
