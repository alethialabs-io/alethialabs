// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// irsaRepoRoot walks up from the test's working directory to the monorepo root, identified by
// go.work. Returns "" when not in a monorepo checkout (the template scrape then skips rather than
// false-alarming) — the same shape as packages/core/compat's coupling drift test.
func irsaRepoRoot(t *testing.T) string {
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

// TestKeylessDBUserMatchesIRSAPolicy closes the last gap in the alethia_app coupling.
//
// The login the keyless app authenticates as is named in three places. Two of them now share a Go
// symbol (KeylessDBUser here; the runner's keylessBootstrapRole aliases it). The third is the AWS IAM
// policy ARN in irsa.tf, which cannot import Go — so it is asserted here instead of merely commented.
//
// Why this is worth a test rather than a comment: RDS IAM usernames are CASE-SENSITIVE, and a
// mismatch between the ARN's username segment and the role the bootstrap Job actually CREATEs does
// NOT fail `tofu apply`. It produces a policy granting rds-db:connect for a user that does not exist,
// so every connection is denied at runtime with nothing in the plan, the apply, or the manifests
// pointing back at the drift. All three sites previously carried comments asserting they agreed, and
// nothing checked.
func TestKeylessDBUserMatchesIRSAPolicy(t *testing.T) {
	root := irsaRepoRoot(t)
	if root == "" {
		t.Skip("go.work not found; not in a monorepo checkout — skipping template scrape")
	}
	const rel = "infra/templates/project/aws/irsa.tf"
	b, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatalf("read %s: %v (template moved? re-anchor this coupling)", rel, err)
	}

	// The Resource ARN's trailing username segment: arn:aws:rds-db:…:dbuser:<resource-id>/<username>
	re := regexp.MustCompile(`arn:aws:rds-db:[^"]*:dbuser:[^"/]*/([A-Za-z0-9_$]+)"`)
	m := re.FindStringSubmatch(string(b))
	if m == nil {
		t.Fatalf("no rds-db:connect dbuser ARN found in %s — the policy's shape changed, so this "+
			"coupling no longer verifies anything; re-anchor the pattern", rel)
	}
	if m[1] != KeylessDBUser {
		t.Errorf("irsa.tf grants rds-db:connect as %q but the bootstrap Job creates %q (%s:KeylessDBUser).\n"+
			"RDS IAM usernames are case-sensitive and this does NOT fail the apply — it grants connect "+
			"for a user that does not exist, denying every connection at runtime.",
			m[1], KeylessDBUser, "packages/core/manifests/keyless.go")
	}
}
