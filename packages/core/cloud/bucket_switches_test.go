// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// bucketSwitchCell is one cloud's answer to a canvas bucket switch: the tfvars key the switch
// becomes inside that cloud's bucket collection, and the value each position of the switch produces.
//
// The KEY is half the assertion and the half that was wrong. Both cells fixed here failed on the
// name rather than the value: gcp sent `uniform_access` (a different feature entirely) and azure
// sent `container_access_type` while its module declares `access_type`. Nothing errored — a tofu
// object type discards attributes it does not declare, in silence — so the plan came out identical
// whichever way the user set the switch.
type bucketSwitchCell struct {
	cloud string
	build func(*types.ProjectConfig) map[string]interface{}
	// tfvar is the root collection the buckets arrive in on this cloud.
	tfvar string
	// key is the attribute inside each bucket entry that carries the switch. It must be a name the
	// cloud's TEMPLATE declares and reads — that pairing is what the offer-parity carrier probe
	// measures, and a mismatch here is invisible to every other test in this package.
	key string
	// on/off are the values the two positions of the switch must produce. Asserting BOTH is the
	// point: an emitter that hardcoded the enabled value would satisfy a one-sided test, and that
	// is exactly the shape of a fix that is really a no-op.
	on, off interface{}
}

// bucketEntries pulls the per-bucket entries out of a cloud's tfvars, whichever concrete slice type
// that provider happens to build.
func bucketEntries(t *testing.T, tfvars map[string]interface{}, key string) []map[string]interface{} {
	t.Helper()
	v, ok := tfvars[key]
	if !ok {
		t.Fatalf("tfvar %q is absent — the buckets never reach the template at all", key)
	}
	entries, ok := v.([]map[string]interface{})
	if !ok {
		t.Fatalf("tfvar %q has type %T, want []map[string]interface{}", key, v)
	}
	return entries
}

func bucketSwitchConfig(b types.ProjectStorageBucketConfig) *types.ProjectConfig {
	return &types.ProjectConfig{
		Cluster:        types.ProjectClusterConfig{ProviderConfig: map[string]any{}},
		DNS:            types.ProjectDNSConfig{ProviderConfig: map[string]any{}},
		Network:        types.ProjectNetworkConfig{CIDRBlock: "10.0.0.0/16"},
		StorageBuckets: []types.ProjectStorageBucketConfig{b},
	}
}

// TestBucketPublicAccessReachesEachCloudsOwnTfvarName asserts that `public_access` becomes a tfvars
// key the template declares AND reads, with a DIFFERENT value in each position of the switch.
//
// GCP is the interesting one. It used to emit `!PublicAccess` as `uniform_access`, which is a real
// argument that means something else: uniform bucket-level access disables per-object ACLs and has
// no bearing on whether the public may read the bucket. Worse, GCS refuses to turn UBLA back off
// more than 90 days after it was enabled, so a switch routed through it would become an apply that
// can never succeed on any bucket older than three months. The value is now sent verbatim and the
// template decides `public_access_prevention` plus the allUsers binding from it.
func TestBucketPublicAccessReachesEachCloudsOwnTfvarName(t *testing.T) {
	cells := []bucketSwitchCell{
		{
			cloud: "gcp",
			build: (&gcpProvider{}).ProviderTfvars,
			tfvar: "cloud_storage_buckets",
			key:   "public_access",
			on:    true,
			off:   false,
		},
		{
			cloud: "azure",
			build: (&azureProvider{}).ProviderTfvars,
			tfvar: "storage_containers",
			key:   "access_type",
			on:    "blob",
			off:   "private",
		},
	}

	for _, c := range cells {
		t.Run(c.cloud, func(t *testing.T) {
			on := bucketEntries(t, c.build(bucketSwitchConfig(
				types.ProjectStorageBucketConfig{Name: "assets", PublicAccess: true})), c.tfvar)
			off := bucketEntries(t, c.build(bucketSwitchConfig(
				types.ProjectStorageBucketConfig{Name: "assets", PublicAccess: false})), c.tfvar)

			if len(on) != 1 || len(off) != 1 {
				t.Fatalf("expected one bucket entry per position, got %d/%d", len(on), len(off))
			}
			if got, ok := on[0][c.key]; !ok || got != c.on {
				t.Errorf("public_access ON: %s[0][%q] = %v (present=%v), want %v", c.tfvar, c.key, got, ok, c.on)
			}
			if got, ok := off[0][c.key]; !ok || got != c.off {
				t.Errorf("public_access OFF: %s[0][%q] = %v (present=%v), want %v", c.tfvar, c.key, got, ok, c.off)
			}
			// The property that makes this a switch rather than a decoration.
			if on[0][c.key] == off[0][c.key] {
				t.Errorf("both positions of public_access produce %v on %s — the switch does nothing", on[0][c.key], c.cloud)
			}
		})
	}
}

// TestBucketVersioningReachesEachCloudsOwnTfvarName asserts the same for `versioning`.
//
// Azure never looked at the field at all, so containers were created unversioned however the switch
// was set. The value is emitted PER CONTAINER even though azurerm only offers blob versioning at
// ACCOUNT scope, so that the coarsening happens in one visible place in the template rather than
// being decided silently here.
func TestBucketVersioningReachesEachCloudsOwnTfvarName(t *testing.T) {
	cells := []bucketSwitchCell{
		{
			cloud: "gcp",
			build: (&gcpProvider{}).ProviderTfvars,
			tfvar: "cloud_storage_buckets",
			key:   "versioning",
			on:    true,
			off:   false,
		},
		{
			cloud: "azure",
			build: (&azureProvider{}).ProviderTfvars,
			tfvar: "storage_containers",
			key:   "versioning_enabled",
			on:    true,
			off:   false,
		},
	}

	for _, c := range cells {
		t.Run(c.cloud, func(t *testing.T) {
			on := bucketEntries(t, c.build(bucketSwitchConfig(
				types.ProjectStorageBucketConfig{Name: "assets", Versioning: true})), c.tfvar)
			off := bucketEntries(t, c.build(bucketSwitchConfig(
				types.ProjectStorageBucketConfig{Name: "assets", Versioning: false})), c.tfvar)

			if got, ok := on[0][c.key]; !ok || got != c.on {
				t.Errorf("versioning ON: %s[0][%q] = %v (present=%v), want %v", c.tfvar, c.key, got, ok, c.on)
			}
			if got, ok := off[0][c.key]; !ok || got != c.off {
				t.Errorf("versioning OFF: %s[0][%q] = %v (present=%v), want %v", c.tfvar, c.key, got, ok, c.off)
			}
			if on[0][c.key] == off[0][c.key] {
				t.Errorf("both positions of versioning produce %v on %s — the switch does nothing", on[0][c.key], c.cloud)
			}
		})
	}
}

// TestBucketSwitchesAreIndependent pins that the two switches do not ride on each other. They share
// one bucket entry on both clouds, and a single misplaced assignment would make one silently set
// the other — a bug no per-switch test above could see, because each would still pass alone.
func TestBucketSwitchesAreIndependent(t *testing.T) {
	type probe struct {
		cloud                  string
		build                  func(*types.ProjectConfig) map[string]interface{}
		tfvar, pubKey, verKey  string
		pubPrivate, pubPublic  interface{}
		verDisabled, verOnKind interface{}
	}
	probes := []probe{
		{"gcp", (&gcpProvider{}).ProviderTfvars, "cloud_storage_buckets", "public_access", "versioning", false, true, false, true},
		{"azure", (&azureProvider{}).ProviderTfvars, "storage_containers", "access_type", "versioning_enabled", "private", "blob", false, true},
	}

	for _, p := range probes {
		t.Run(p.cloud, func(t *testing.T) {
			// Public but unversioned.
			e := bucketEntries(t, p.build(bucketSwitchConfig(
				types.ProjectStorageBucketConfig{Name: "assets", PublicAccess: true, Versioning: false})), p.tfvar)[0]
			if e[p.pubKey] != p.pubPublic || e[p.verKey] != p.verDisabled {
				t.Errorf("public+unversioned gave %v/%v, want %v/%v", e[p.pubKey], e[p.verKey], p.pubPublic, p.verDisabled)
			}

			// Versioned but private.
			e = bucketEntries(t, p.build(bucketSwitchConfig(
				types.ProjectStorageBucketConfig{Name: "assets", PublicAccess: false, Versioning: true})), p.tfvar)[0]
			if e[p.pubKey] != p.pubPrivate || e[p.verKey] != p.verOnKind {
				t.Errorf("private+versioned gave %v/%v, want %v/%v", e[p.pubKey], e[p.verKey], p.pubPrivate, p.verOnKind)
			}
		})
	}
}
