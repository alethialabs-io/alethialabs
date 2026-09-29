// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The `dns-cert` beat (#5087): on a cli-demo run that proves the ACM certificate, the CLI authors
// the brought zone and the certificate ask, because the seeded path's snapshot layer never reaches a
// DEPLOY the CLI enqueues. Untagged, so ci.yml runs it on every PR.

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

// cliDemoAuthoringArgv returns the argv the authoring phase would perform for the named step on this
// run, or nil when the phase withholds it.
func cliDemoAuthoringArgv(run *CLIDemoRun, stepID string) []string {
	beats, _ := cliDemoBeatsFor(run, CLIDemoAuthoring)
	for _, b := range beats {
		if b.StepID == stepID {
			return b.Args(run)
		}
	}
	return nil
}

// hasSet reports whether argv carries `--set <pair>` as two adjacent tokens.
func hasSet(argv []string, pair string) bool {
	for i := 0; i+1 < len(argv); i++ {
		if argv[i] == "--set" && argv[i+1] == pair {
			return true
		}
	}
	return false
}

// hasFlag reports whether argv carries `<flag> <value>` as two adjacent tokens.
func hasFlag(argv []string, flag, value string) bool {
	for i := 0; i+1 < len(argv); i++ {
		if argv[i] == flag && argv[i+1] == value {
			return true
		}
	}
	return false
}

// On a run that proves the certificate, the authoring phase performs `dns-cert` with the zone, the
// run-scoped domain and the certificate ask. The values come from the same acmCertConfig the seeded
// path writes, through cliDemoCertZoneFrom.
func TestCLIDemoDNSCertBeatCarriesTheZoneAndTheAskWhenTheCertIsOn(t *testing.T) {
	cfg := acmCertConfig{provider: "aws", enabled: true, zoneID: "Z0395392Z0SAB8SFGNLX", zoneName: "e2e.alethialabs.io",
		domainName: "36639509726-1.e2e.alethialabs.io", runEnv: "36639509726-1"}
	run := &CLIDemoRun{Provider: "aws", ProjectID: "p-1", EnvName: "36639509726-1", CertZone: cliDemoCertZoneFrom(cfg, true)}

	argv := cliDemoAuthoringArgv(run, "dns-cert")
	if argv == nil {
		t.Fatal("the authoring phase does not perform `dns-cert` on a run that proves the certificate — the " +
			"CLI-created DEPLOY would ask for no certificate and runT2AcmCert would assert one nobody requested")
	}
	if !slices.Equal(argv[:3], []string{"project", "component", "add"}) {
		t.Errorf("dns-cert argv = %v, want `project component add …`", argv)
	}
	for _, f := range [][2]string{{"--kind", "dns"}, {"--project", "p-1"}, {"--env", "36639509726-1"}} {
		if !hasFlag(argv, f[0], f[1]) {
			t.Errorf("dns-cert argv lacks `%s %s`: %v", f[0], f[1], argv)
		}
	}
	for _, pair := range []string{
		"enabled=true",
		"zone_id=Z0395392Z0SAB8SFGNLX",
		"domain_name=36639509726-1.e2e.alethialabs.io",
		"managed_certificate=true",
	} {
		if !hasSet(argv, pair) {
			t.Errorf("dns-cert argv lacks `--set %s`: %v", pair, argv)
		}
	}
	if argv[len(argv)-1] != "--no-input" {
		t.Errorf("dns-cert argv does not end in --no-input — a prompt in CI hangs until the context kills it: %v", argv)
	}
}

// On a run that does not prove the certificate, the beat is WITHHELD with a logged reason, and the
// rest of the authoring phase is unchanged.
func TestCLIDemoDNSCertBeatIsWithheldWhenTheCertIsOff(t *testing.T) {
	cfg := acmCertConfig{provider: "aws", zoneID: "Z1", zoneName: "e2e.alethialabs.io", domainName: "r.e2e.alethialabs.io"}
	if z := cliDemoCertZoneFrom(cfg, false); z != nil {
		t.Fatalf("cliDemoCertZoneFrom(off) = %+v, want nil — a zone on a run that does not assert the certificate "+
			"writes a validation record into the shared zone for nothing", z)
	}
	run := &CLIDemoRun{Provider: "aws", ProjectID: "p-1", EnvName: "e"}

	if argv := cliDemoAuthoringArgv(run, "dns-cert"); argv != nil {
		t.Errorf("the authoring phase performs `dns-cert` with no zone: %v", argv)
	}
	_, skipped := cliDemoBeatsFor(run, CLIDemoAuthoring)
	if len(skipped) != 1 || !strings.HasPrefix(skipped[0], "dns-cert: ") {
		t.Errorf("skipped = %q, want exactly the dns-cert beat withheld with a reason", skipped)
	}
	// Withholding one beat must not withhold its neighbours.
	for _, id := range []string{"project-create", "component-add", "apps-repo", "chart-attach", "staged"} {
		if cliDemoAuthoringArgv(run, id) == nil {
			t.Errorf("beat %q is missing from the authoring phase once dns-cert is withheld", id)
		}
	}
	on := &CLIDemoRun{CertZone: &CLIDemoCertZone{ZoneID: "Z1", DomainName: "d"}}
	if got, want := cliDemoPerformedBeatCount(run), cliDemoPerformedBeatCount(on)-1; got != want {
		t.Errorf("performed beat count without a zone = %d, want %d — the closing log would claim a beat it withheld", got, want)
	}
}

// dnsComponentList renders what `project component list --kind dns --output json` returns.
func dnsComponentList(t *testing.T, cfg map[string]any) string {
	t.Helper()
	b, err := json.Marshal([]map[string]any{{"kind": "dns", "config": cfg}})
	if err != nil {
		t.Fatal(err)
	}
	return "Components\n" + string(b)
}

func TestAssertDNSCertWiredComparesEveryField(t *testing.T) {
	run := &CLIDemoRun{EnvName: "e", CertZone: &CLIDemoCertZone{ZoneID: "Z1", DomainName: "r.e2e.alethialabs.io"}}
	good := func() map[string]any {
		return map[string]any{"enabled": true, "zone_id": "Z1", "domain_name": "r.e2e.alethialabs.io", "managed_certificate": true}
	}
	if err := assertDNSCertWired(run, dnsComponentList(t, good())); err != nil {
		t.Fatalf("the exact stored shape was refused: %v", err)
	}
	for field, bad := range map[string]any{
		"enabled":             false,
		"zone_id":             "",
		"domain_name":         "e2e.alethialabs.io",
		"managed_certificate": false,
	} {
		cfg := good()
		cfg[field] = bad
		err := assertDNSCertWired(run, dnsComponentList(t, cfg))
		if err == nil || !strings.Contains(err.Error(), field) {
			t.Errorf("%s=%v was accepted or not named (err=%v)", field, bad, err)
		}
	}
	if err := assertDNSCertWired(run, `[{"kind":"cluster","config":{}}]`); err == nil {
		t.Error("a list with no dns component was accepted")
	}
}

// The run half's ask check must accept BOTH ways a job asks — the seeded path's provider_config
// override and the console's typed field — and refuse the shape run 36639509726 carried.
func TestAcmCertAskFromSnapshot(t *testing.T) {
	const zone = "Z0395392Z0SAB8SFGNLX"

	seeded := map[string]any{"dns": map[string]any{"enabled": false}}
	acmCertConfig{zoneID: zone, domainName: "r.e2e.alethialabs.io"}.applyToSnapshot(seeded)
	seededRaw, err := json.Marshal(seeded)
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{"seeded path (provider_config.acm_certificate)", string(seededRaw), true},
		{"cli path (typed managed_certificate)",
			`{"dns":{"enabled":true,"zone_id":"` + zone + `","domain_name":"r","managed_certificate":true,"provider_config":{}}}`, true},
		{"override turns the typed ask off",
			`{"dns":{"enabled":true,"zone_id":"` + zone + `","managed_certificate":true,"provider_config":{"acm_certificate":false}}}`, false},
		{"run 36639509726: no zone, no ask",
			`{"dns":{"enabled":false,"provider":"","provider_config":{}}}`, false},
		{"asked, but in a zone of its own",
			`{"dns":{"enabled":true,"zone_id":"ZOTHER","managed_certificate":true}}`, false},
		{"asked, but dns disabled",
			`{"dns":{"enabled":false,"zone_id":"` + zone + `","managed_certificate":true}}`, false},
		{"no dns block", `{"cluster":{}}`, false},
	}
	for _, c := range cases {
		got, carried, err := acmCertAskFromSnapshot([]byte(c.raw), zone)
		if err != nil {
			t.Errorf("%s: unexpected error %v", c.name, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s: asked = %v, want %v (carried: %s)", c.name, got, c.want, carried)
		}
		if carried == "" {
			t.Errorf("%s: carried is empty — a refusal must say what the snapshot held", c.name)
		}
	}
	if _, _, err := acmCertAskFromSnapshot(nil, zone); err == nil {
		t.Error("an empty config_snapshot was read as an answer rather than an error")
	}
	if _, _, err := acmCertAskFromSnapshot([]byte("{"), zone); err == nil {
		t.Error("a malformed config_snapshot was read as an answer rather than an error")
	}
}
