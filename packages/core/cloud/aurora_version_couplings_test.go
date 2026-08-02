// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The Aurora PostgreSQL version used to exist as four uncoupled literals: this package's provider
// fallback, the template's `rds_config` variable (BOTH its optional() default and its whole-object
// default), and the rds module's default. Nothing tied them together, and the root/module copies had
// already drifted apart on `cluster_size` and `rds_scaling_config` — proof the hazard was live, not
// theoretical.
//
// The tests below make that drift a build failure. They are the cheap half of the guard: they run on
// every PR with no cloud credentials and catch the copies disagreeing. They CANNOT catch AWS
// withdrawing the pinned version — that is catalog-drift.yml's job, monthly and credentialed.

const auroraTemplateBase = "infra/templates/project/aws"

// repoRootForCouplings walks up to the directory holding go.work. Returns "" outside a monorepo
// checkout (e.g. a module extracted on its own), where the template scrape is meaningless.
func repoRootForCouplings(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// readCouplingSource reads a repo-root-relative coupling source. A missing file is a HARD failure,
// not a skip: the template was moved or renamed without updating this test, which is itself the
// drift this file exists to catch.
func readCouplingSource(t *testing.T, root, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatalf("read coupling source %s: %v (template moved? re-anchor this test)", rel, err)
	}
	return string(b)
}

// TestAuroraVersionCouplings asserts every checked-in Aurora PostgreSQL version default equals
// DefaultAuroraPostgresVersion. Change one and this fails, naming the file that drifted.
func TestAuroraVersionCouplings(t *testing.T) {
	root := repoRootForCouplings(t)
	if root == "" {
		t.Skip("go.work not found; not in a monorepo checkout — skipping template scrape")
	}

	rootVars := auroraTemplateBase + "/variables.tf"
	moduleVars := auroraTemplateBase + "/modules/rds/variables.tf"

	// Both `engine_version = "<v>"` and `engine_version = optional(string, "<v>")` forms, so the
	// scrape survives either being rewritten into the other.
	engineVersionRE := regexp.MustCompile(
		`(?m)^\s*engine_version\s*=\s*(?:optional\(string,\s*)?"([^"]+)"`)

	for _, rel := range []string{rootVars, moduleVars} {
		src := readCouplingSource(t, root, rel)
		matches := engineVersionRE.FindAllStringSubmatch(src, -1)
		if len(matches) == 0 {
			t.Fatalf("no engine_version default found in %s (format changed? re-anchor this coupling)", rel)
		}
		for _, m := range matches {
			if m[1] != DefaultAuroraPostgresVersion {
				t.Errorf("%s pins engine_version %q but cloud.DefaultAuroraPostgresVersion is %q — "+
					"change them in lockstep", rel, m[1], DefaultAuroraPostgresVersion)
			}
		}
	}

	// Non-vacuity: the root variable declares the pin TWICE (optional() + whole-object default) and
	// the module once. If a refactor collapses them, this count tells us to re-check the guard
	// rather than let it silently assert nothing.
	rootMatches := engineVersionRE.FindAllString(readCouplingSource(t, root, rootVars), -1)
	if len(rootMatches) != 2 {
		t.Errorf("expected 2 engine_version defaults in %s (optional() + whole-object), found %d — "+
			"the duplication changed; confirm this test still covers every copy", rootVars, len(rootMatches))
	}
}

// TestAuroraClusterFamilyTracksVersion guards the OTHER half of the pair. RDS-ENGINE-001
// (checks_data.tf) blocks an apply where cluster_family disagrees with the ENGINE, but nothing
// checks the family tracks the VERSION's major — so bumping 16.x → 17.x while leaving
// `aurora-postgresql16` behind would sail past that gate and compose a cluster on the wrong
// parameter-group family.
func TestAuroraClusterFamilyTracksVersion(t *testing.T) {
	root := repoRootForCouplings(t)
	if root == "" {
		t.Skip("go.work not found; not in a monorepo checkout — skipping template scrape")
	}

	major, _, _ := strings.Cut(DefaultAuroraPostgresVersion, ".")
	if major == "" {
		t.Fatalf("DefaultAuroraPostgresVersion %q has no major segment", DefaultAuroraPostgresVersion)
	}
	want := "aurora-postgresql" + major

	// The provider derives the family from engine+version at runtime; assert that derivation agrees
	// with the literal the templates ship, so the two routes can never diverge.
	if got := awsAuroraFamily("aurora-postgresql", DefaultAuroraPostgresVersion); got != want {
		t.Errorf("awsAuroraFamily derived %q for %q, want %q",
			got, DefaultAuroraPostgresVersion, want)
	}

	familyRE := regexp.MustCompile(
		`(?m)^\s*cluster_family\s*=\s*(?:optional\(string,\s*)?"([^"]+)"`)

	for _, rel := range []string{
		auroraTemplateBase + "/variables.tf",
		auroraTemplateBase + "/modules/rds/variables.tf",
	} {
		src := readCouplingSource(t, root, rel)
		matches := familyRE.FindAllStringSubmatch(src, -1)
		if len(matches) == 0 {
			t.Fatalf("no cluster_family default found in %s (format changed? re-anchor this coupling)", rel)
		}
		for _, m := range matches {
			if m[1] != want {
				t.Errorf("%s pins cluster_family %q but DefaultAuroraPostgresVersion %q implies %q — "+
					"an Aurora PostgreSQL family is major-only and must track the pinned version",
					rel, m[1], DefaultAuroraPostgresVersion, want)
			}
		}
	}
}

// TestDefaultAuroraPostgresVersionIsAFullMinor pins the SHAPE of the constant. AWS's
// DescribeOrderableDBInstanceOptions rejects a bare major ("Engine version is not a valid full
// version"), so a well-meaning bump to "17" — matching the gcp and azure templates, which DO take
// bare majors — would break every AWS apply. This test is why that mistake is caught at desk time.
func TestDefaultAuroraPostgresVersionIsAFullMinor(t *testing.T) {
	if !regexp.MustCompile(`^\d+\.\d+$`).MatchString(DefaultAuroraPostgresVersion) {
		t.Errorf("DefaultAuroraPostgresVersion = %q; Aurora needs a full MAJOR.MINOR — AWS rejects a "+
			"bare major with \"Engine version is not a valid full version\"", DefaultAuroraPostgresVersion)
	}
}
