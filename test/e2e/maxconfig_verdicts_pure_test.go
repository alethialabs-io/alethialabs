// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FREE, every-PR read-back of the max-config VERDICT table — NO build tag, NO cloud, NO tofu.
//
// The table in maxconfig.go is only as good as the guarantee that every (kind × cloud) cell is
// filled in. It was not: the table carried AWS/GCP/Azure resource columns and nothing else,
// ResourceFor() returned "" for hetzner and alibaba, and AssertMaxConfigKindsInState reported those
// 22 cells as "unmapped" with a t.Logf before logging "all mapped kinds present". Two of the five
// clouds could never be proven max-config, and the harness read as though it were merely pending.
//
// So the mapping is read BACK here, mechanically, in the tier that runs on every PR:
//
//   - the cloud set comes from the harness's own t2ProviderTable, so a sixth cloud reds this file
//     until it has a column;
//   - the kind set comes from MaxConfigKinds itself, so a twelfth kind reds it until every cloud
//     states what it does with it;
//   - each cell must be a WELL-FORMED verdict (MaxConfigCell.Validate), not merely non-empty;
//   - and the assertion entry point must REFUSE a cloud it cannot describe, rather than skip it.
//
// This is the generated-mirror discipline applied to a hand-written table: the table stays legible,
// and it polices itself.
package e2e

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestMaxConfigEveryCellCarriesAVerdict is the core read-back: 11 kinds × every cloud the harness
// can run, each with a well-formed verdict. There is no "pending" state — a cell that has not been
// decided fails here, before anyone spends a nightly discovering it asserted nothing.
func TestMaxConfigEveryCellCarriesAVerdict(t *testing.T) {
	clouds := maxConfigClouds()
	if len(clouds) == 0 {
		t.Fatal("t2ProviderTable is empty — this guard would pass vacuously")
	}
	for _, provider := range clouds {
		t.Run(provider, func(t *testing.T) {
			for _, k := range MaxConfigKinds {
				cell, ok := k.Cell(provider)
				if !ok {
					t.Fatalf("cloud %q has NO column in MaxConfigKind (kind %q). Adding a cloud to the harness "+
						"means adding its column plus a row value per kind — never leaving it to fall through to "+
						"a skip, which is how hetzner and alibaba stayed unassertable.", provider, k.Kind)
				}
				if err := cell.Validate(); err != nil {
					t.Errorf("kind %q × cloud %q: %v", k.Kind, provider, err)
				}
			}
		})
	}
}

// TestMaxConfigNoCloudIsEntirelyExcluded proves each cloud has something to prove. A cloud whose
// every kind is excluded — a documented ceiling OR deferred debt — would satisfy the verdict guard
// above while asserting nothing at all (the same vacuous green in a new costume), so
// AssertMaxConfigKindsInState errors on it and this pins the table on the near side of that error.
func TestMaxConfigNoCloudIsEntirelyExcluded(t *testing.T) {
	for _, provider := range maxConfigClouds() {
		t.Run(provider, func(t *testing.T) {
			assertable := 0
			for _, k := range MaxConfigKinds {
				if maxConfigCell(t, k, provider).Offered() {
					assertable++
				}
			}
			if assertable == 0 {
				t.Errorf("every kind is excluded on %q (ceiling or deferred) — a max-config run there proves nothing", provider)
			}
		})
	}
}

// TestMaxConfigDeferredCellsNameTheirChart is the guard that keeps DeferredInProduct from decaying
// into a politer CloudCeiling.
//
// The verdict claims something specific and checkable: a chart THIS REPO ALREADY SHIPS backs the
// kind, and only the mapping is missing. If that claim can be made without naming the chart, the
// distinction stops being load-bearing within a release — which is exactly how the previous single
// ceiling string ended up appending "(Vault is a marketplace add-on…)" to a sentence that read "no
// chart or cloud service backs it".
//
// So: every deferred cell must name a chart, and the name must be one the add-on catalog fixture
// actually holds — the same generated artifact the full-bar run installs from. A deferred cell whose
// chart is not installable is a ceiling with extra words.
//
// ⚠️ IT MUST NOT GO VACUOUS WHEN THE DEBT IS PAID. This guard used to end with "if we found no
// deferred cell at all, fail" — which was correct while hetzner's secrets and registry were both
// deferred, and became a TRAP the moment they were not: #2431 and #2432 wired the last two, so a
// table with zero debt is now the CORRECT state and that check would red the build for succeeding.
// Deleting it instead would leave a guard that silently asserts nothing on an empty set. So the
// rule is extracted into a predicate, the table is checked with it, and the predicate is then
// SELF-TESTED against synthetic cells — unconditionally, whether or not the table has any debt
// left. The guard keeps its teeth on an empty table, which is the state we intend to stay in.
func TestMaxConfigDeferredCellsNameTheirChart(t *testing.T) {
	catalog, err := AllCatalogAddOns()
	if err != nil {
		t.Fatalf("load add-on catalog fixture: %v", err)
	}
	for _, provider := range maxConfigClouds() {
		for _, k := range MaxConfigKinds {
			cell := maxConfigCell(t, k, provider)
			if cell.Carriage != DeferredInProduct {
				continue
			}
			if verr := deferredCellNamesAShippedChart(cell, catalog); verr != nil {
				t.Errorf("kind %q on %s: %v", k.Kind, provider, verr)
			}
		}
	}

	// The self-test. Each case is a real way a deferred cell decays into a ceiling with extra words.
	t.Run("the rule still rejects what it exists to reject", func(t *testing.T) {
		// Built from the repo's OWN canonical debt reason, not a hand-written stand-in: editing
		// hetznerChartExistsNotWired to drop the word DEBT reds this, which is what keeps that
		// currently-unused constant honest rather than decorative.
		good := deferredCell("vault (marketplace catalog)", hetznerChartExistsNotWired)
		if verr := deferredCellNamesAShippedChart(good, catalog); verr != nil {
			t.Errorf("a well-formed deferred cell was rejected: %v — the rule has drifted off the shape it is meant to admit", verr)
		}
		for name, bad := range map[string]MaxConfigCell{
			"names a chart no catalog add-on ships":     deferredCell("not-a-real-chart", "no cloud service — DEBT"),
			"a Why that never says DEBT":                deferredCell("vault (marketplace catalog)", "Hetzner has no cloud service for this kind"),
			"names a chart that is only an explanation": deferredCell(" (see the docs)", hetznerChartExistsNotWired),
			"no chart at all":                           {Carriage: DeferredInProduct, Why: "no cloud service — DEBT"},
		} {
			if verr := deferredCellNamesAShippedChart(bad, catalog); verr == nil {
				t.Errorf("a deferred cell that %s was accepted — the guard would not catch the decay it exists to catch", name)
			}
		}
	})
}

// deferredCellNamesAShippedChart reports why a DeferredInProduct cell fails to justify its verdict
// (nil = it does). Split out of the table walk so it can be self-tested on synthetic cells, which is
// what keeps the guard honest once the table itself holds no debt.
func deferredCellNamesAShippedChart(cell MaxConfigCell, catalog []types.AddOnInstall) error {
	// The Chart field leads with the catalog id, then explains itself.
	id, _, _ := strings.Cut(cell.Chart, " ")
	installable := false
	for _, a := range catalog {
		if a.ID == id {
			installable = true
			break
		}
	}
	if !installable {
		return fmt.Errorf("is %s and names chart %q, but %q is in NO catalog add-on — "+
			"the whole claim of this verdict is that a SHIPPED chart backs the kind, so an unfindable one means the cell is really a %s",
			DeferredInProduct, cell.Chart, id, CloudCeiling)
	}
	if !strings.Contains(cell.Why, "DEBT") {
		return fmt.Errorf("is %s but its Why never says DEBT — the reason a reader takes away must be "+
			"\"we have not wired this\", not \"the cloud cannot\": %q", DeferredInProduct, cell.Why)
	}
	return nil
}

// maxConfigResourcePrefixes are the tofu resource-type prefixes each cloud's template can actually
// produce. The check they drive is narrow but it catches the realistic mistake when a column is
// added: copying a neighbouring cloud's resource type into the new cell. A wrong-but-plausible type
// (aws_sqs_queue in the Alibaba column) counts zero on a real apply and reads as a missing kind
// weeks later, in a main-gated run.
//
// hetzner needs four prefixes, and that is the template's genuine shape, not laxity: the cluster is
// siderolabs/talos (talos_machine_bootstrap), the cloud resources are hcloud_*, and Object Storage is
// Hetzner's real S3 product driven through the aminueza/minio provider (minio_s3_bucket).
var maxConfigResourcePrefixes = map[string][]string{
	"aws":     {"aws_"},
	"gcp":     {"google_"},
	"azure":   {"azurerm_"},
	"hetzner": {"hcloud_", "talos_", "minio_"},
	"alibaba": {"alicloud_"},
}

// TestMaxConfigResourceTypesBelongToTheirCloud guards the per-cloud columns against a copy-paste.
func TestMaxConfigResourceTypesBelongToTheirCloud(t *testing.T) {
	for _, provider := range maxConfigClouds() {
		prefixes, ok := maxConfigResourcePrefixes[provider]
		if !ok {
			t.Errorf("cloud %q has no declared resource-type prefixes — add them alongside its column so a copy-pasted resource type is caught", provider)
			continue
		}
		t.Run(provider, func(t *testing.T) {
			for _, k := range MaxConfigKinds {
				cell := maxConfigCell(t, k, provider)
				if cell.Carriage != CarriedByTofu {
					continue
				}
				matched := false
				for _, p := range prefixes {
					if strings.HasPrefix(cell.Resource, p) {
						matched = true
						break
					}
				}
				if !matched {
					t.Errorf("kind %q on %s names tofu resource %q, which starts with none of %v — a resource type from another cloud counts ZERO in state and surfaces as a missing kind",
						k.Kind, provider, cell.Resource, prefixes)
				}
			}
		})
	}
}

// TestMaxConfigInClusterAppsAreDerivedNames pins the in-cluster verdict's assertable signal to the
// runner's own naming rule. packages/core/argocd.AddOnAppName is `"addon-" + id`, and Hetzner's ids
// are `db-<name>` / `cache-<name>` / `queue-<name>` built from the component name
// (apps/console/lib/cloud-providers/hetzner-services.ts). The table derives its ArgoApp from the same
// maxConfig*Name constants the fixture uses, so renaming a component moves the assertion with it —
// this proves the derivation actually holds rather than a literal having been typed twice.
func TestMaxConfigInClusterAppsAreDerivedNames(t *testing.T) {
	byKind := map[string]string{
		"database": "addon-db-" + maxConfigDatabaseName,
		"cache":    "addon-cache-" + maxConfigCacheName,
		"queue":    "addon-queue-" + maxConfigQueueName,
	}
	found := 0
	for _, provider := range maxConfigClouds() {
		for _, k := range MaxConfigKinds {
			cell := maxConfigCell(t, k, provider)
			if cell.Carriage != CarriedInCluster {
				continue
			}
			found++
			if !strings.HasPrefix(cell.ArgoApp, "addon-") {
				t.Errorf("kind %q on %s names ArgoCD Application %q — the runner renders add-on Applications as AddOnAppName(id) = \"addon-\"+id, so this name can never appear",
					k.Kind, provider, cell.ArgoApp)
			}
			if want, ok := byKind[k.Kind]; ok && cell.ArgoApp != want {
				t.Errorf("kind %q on %s names ArgoCD Application %q, want %q (derived from the max-config component name)",
					k.Kind, provider, cell.ArgoApp, want)
			}
		}
	}
	if found == 0 {
		t.Error("no CarriedInCluster cell in the whole table — Hetzner's database/cache/queue are in-cluster charts, so this guard has stopped guarding anything")
	}
}

// TestMaxConfigCellValidateRejectsHalfFilledCells is the negative for the verdict type itself: the
// combinations that would silently under-assert must not validate. Without these, a cell could carry
// a carriage and nothing else and pass the read-back above.
func TestMaxConfigCellValidateRejectsHalfFilledCells(t *testing.T) {
	cases := map[string]MaxConfigCell{
		"no carriage at all (the original defect)": {},
		"unknown carriage":                         {Carriage: "someday"},
		"tofu with no resource type":               {Carriage: CarriedByTofu, Signals: []string{"create_x"}},
		"tofu with no signals":                     {Carriage: CarriedByTofu, Resource: "aws_vpc"},
		"tofu that also names an ArgoCD app":       {Carriage: CarriedByTofu, Resource: "aws_vpc", Signals: []string{"x"}, ArgoApp: "addon-x"},
		"in-cluster with no Application":           {Carriage: CarriedInCluster, Why: "because"},
		"in-cluster claiming a tofu resource":      {Carriage: CarriedInCluster, ArgoApp: "addon-x", Resource: "aws_vpc", Why: "because"},
		"in-cluster with no reason":                {Carriage: CarriedInCluster, ArgoApp: "addon-x"},
		"ceiling that still names a resource":      {Carriage: CloudCeiling, Resource: "aws_vpc", Why: "because"},
		"ceiling with no documented reason":        {Carriage: CloudCeiling},
		// The new verdict's own half-filled shapes. "deferred with no chart" is the important one:
		// without the chart the cell is indistinguishable from a ceiling, which is the incoherence
		// this verdict exists to end rather than rename.
		"deferred with no chart":               {Carriage: DeferredInProduct, Why: "because"},
		"deferred with no reason":              {Carriage: DeferredInProduct, Chart: "vault"},
		"deferred that still names a resource": {Carriage: DeferredInProduct, Chart: "vault", Why: "because", Resource: "aws_vpc"},
		"ceiling that names a chart":           {Carriage: CloudCeiling, Chart: "vault", Why: "because"},
		"tofu that names a chart":              {Carriage: CarriedByTofu, Resource: "aws_vpc", Signals: []string{"x"}, Chart: "vault"},
	}
	for name, cell := range cases {
		t.Run(name, func(t *testing.T) {
			if err := cell.Validate(); err == nil {
				t.Errorf("Validate accepted a half-filled cell (%#v) — that is the shape that under-asserts silently", cell)
			}
		})
	}
	// …and the three well-formed shapes must pass, so the guard is not simply rejecting everything.
	for name, cell := range map[string]MaxConfigCell{
		"tofu":       tofuCell("aws_vpc", "provision_vpc"),
		"in-cluster": inClusterCell("addon-db-appdb", "no managed service on this cloud"),
		"ceiling":    ceilingCell("the cloud does not offer this kind"),
		"deferred":   deferredCell("vault", "a shipped chart backs it; the mapping is missing"),
	} {
		if err := cell.Validate(); err != nil {
			t.Errorf("Validate rejected the well-formed %s cell: %v", name, err)
		}
	}
}

// TestAssertMaxConfigKindsInStateRefusesAnUndescribedCloud is the behavioural half of the fix: the
// entry point must ERROR on a cloud the table cannot describe. The old code returned "" per kind and
// let the caller log a "not yet asserted" line, which is precisely how two clouds stayed unproven.
func TestAssertMaxConfigKindsInStateRefusesAnUndescribedCloud(t *testing.T) {
	state := maxConfigStateWithEveryTofuResource(t, "aws")
	if _, err := AssertMaxConfigKindsInState(state, "oracle", nil); err == nil {
		t.Fatal("a cloud with no column must be an ERROR — skipping it is the defect this replaced")
	}
	if _, err := AssertMaxConfigKindsInState(nil, "aws", nil); err == nil {
		t.Fatal("an empty tofu state must be an ERROR — the deploy wrote nothing")
	}
}

// TestAssertMaxConfigKindsInStateAccountsForEveryKind proves the three verdicts are each ASSERTED,
// per cloud, and that dropping the evidence flips the kind to Missing. Hetzner is the interesting
// row — it is the only cloud using all three carriages — and it is exactly the cloud the previous
// implementation reported as eleven-times-unmapped and then congratulated.
func TestAssertMaxConfigKindsInStateAccountsForEveryKind(t *testing.T) {
	for _, provider := range maxConfigClouds() {
		t.Run(provider, func(t *testing.T) {
			state := maxConfigStateWithEveryTofuResource(t, provider)
			apps := maxConfigInClusterApps(t, provider)

			proof, err := AssertMaxConfigKindsInState(state, provider, apps)
			if err != nil {
				t.Fatalf("AssertMaxConfigKindsInState(%s): %v", provider, err)
			}
			if len(proof.Missing) > 0 {
				t.Errorf("a state carrying every tofu resource and every in-cluster Application still reported missing kinds: %v", proof.Missing)
			}
			total := len(proof.ProvenInTofu) + len(proof.ProvenInCluster) + len(proof.Excluded) + len(proof.Deferred)
			if total != len(MaxConfigKinds) {
				t.Errorf("accounted for %d kinds (%d tofu + %d in-cluster + %d excluded + %d deferred), want all %d — a kind fell through the accounting",
					total, len(proof.ProvenInTofu), len(proof.ProvenInCluster), len(proof.Excluded), len(proof.Deferred), len(MaxConfigKinds))
			}

			// Teeth: an EMPTY-but-valid state and no Applications must make every offered kind Missing,
			// never silently fine.
			empty, aerr := AssertMaxConfigKindsInState([]byte(`{"resources":[]}`), provider, nil)
			if aerr != nil {
				t.Fatalf("AssertMaxConfigKindsInState(empty resources, %s): %v", provider, aerr)
			}
			if len(empty.Missing) != len(proof.ProvenInTofu)+len(proof.ProvenInCluster) {
				t.Errorf("an empty state reported %d missing kinds, want %d (every kind this cloud offers) — the assertion has no teeth: %v",
					len(empty.Missing), len(proof.ProvenInTofu)+len(proof.ProvenInCluster), empty.Missing)
			}
		})
	}
}

// maxConfigStateWithEveryTofuResource synthesizes a tofu state (format v4) holding one managed
// instance of every resource type this cloud's columns name. Derived FROM the table, so it cannot
// drift out of step with it the way a hand-written fixture would.
func maxConfigStateWithEveryTofuResource(t *testing.T, provider string) []byte {
	t.Helper()
	type instance struct{}
	type resource struct {
		Mode      string     `json:"mode"`
		Type      string     `json:"type"`
		Instances []instance `json:"instances"`
	}
	var resources []resource
	for _, k := range MaxConfigKinds {
		cell, ok := k.Cell(provider)
		if !ok || cell.Carriage != CarriedByTofu {
			continue
		}
		resources = append(resources, resource{Mode: "managed", Type: cell.Resource, Instances: []instance{{}}})
	}
	raw, err := json.Marshal(map[string]any{"version": 4, "resources": resources})
	if err != nil {
		t.Fatalf("synthesize tofu state: %v", err)
	}
	return raw
}

// maxConfigInClusterApps lists the ArgoCD Application names this cloud's in-cluster cells expect.
func maxConfigInClusterApps(t *testing.T, provider string) []string {
	t.Helper()
	var apps []string
	for _, k := range MaxConfigKinds {
		cell, ok := k.Cell(provider)
		if !ok || cell.Carriage != CarriedInCluster {
			continue
		}
		apps = append(apps, cell.ArgoApp)
	}
	return apps
}

// TestDeferredCellsStayUnderTheDeclaredRatchet makes PROGRAMME.md's `deferred_in_product` ceiling
// what its own table says it is: "human-set, MACHINE-ENFORCED, may only ever decrease".
//
// It was neither read nor enforced by anything — the two sibling ratchets are enforced by their
// exclusion boards and the CLI gate, and this one was a number in a markdown table. So the count it
// bounds could rise silently, which is precisely the amnesty the ratchet exists to refuse: a new
// chart-backed-but-unwired kind would ship as DEBT with a ceiling already claiming there is none.
//
// The ceiling is read from PROGRAMME.md rather than duplicated here, because a copy is a thing that
// can disagree with the document a human edits.
func TestDeferredCellsStayUnderTheDeclaredRatchet(t *testing.T) {
	ceiling, err := programmeRatchetCeiling("deferred_in_product")
	if err != nil {
		t.Fatalf("read the declared ratchet: %v", err)
	}
	var deferred []string
	for _, provider := range maxConfigClouds() {
		for _, k := range MaxConfigKinds {
			if maxConfigCell(t, k, provider).Carriage == DeferredInProduct {
				deferred = append(deferred, provider+"/"+k.Kind)
			}
		}
	}
	if len(deferred) > ceiling {
		t.Errorf("%d cell(s) are %s — %v — but PROGRAMME.md declares a ceiling of %d. "+
			"The ratchet may only ever DECREASE: either wire the kind, or the maintainer raises the ceiling deliberately "+
			"(which is a decision, not a side effect of landing a PR).",
			len(deferred), DeferredInProduct, deferred, ceiling)
	}
}

// programmeRatchetCeiling reads one row out of PROGRAMME.md's "Declared ratchet ceilings" table.
// A missing or unreadable row is an ERROR, never a skip: a ratchet nobody can find is a ratchet
// nobody enforces, which is the state this test was written to end.
func programmeRatchetCeiling(name string) (int, error) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		return 0, fmt.Errorf("cannot locate this file")
	}
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "PROGRAMME.md")
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, fmt.Errorf("read PROGRAMME.md: %w", err)
	}
	prefix := "| `" + name + "` |"
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(line, prefix) {
			continue
		}
		cols := strings.Split(line, "|")
		if len(cols) < 4 {
			return 0, fmt.Errorf("ratchet row %q is malformed: %q", name, line)
		}
		n, cErr := strconv.Atoi(strings.TrimSpace(cols[2]))
		if cErr != nil {
			return 0, fmt.Errorf("ratchet %q has an unreadable ceiling %q", name, strings.TrimSpace(cols[2]))
		}
		return n, nil
	}
	return 0, fmt.Errorf("PROGRAMME.md declares no ratchet named %q — it was renamed or removed, and this guard now enforces nothing", name)
}
