// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure tests for the keyless-DB real-apply scenario (#1511). Everything here runs without a cloud,
// a cluster or a build tag — the run half is orchestration only, so this is where the scenario's
// decisions are actually pinned.
package e2e

import (
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
)

// keylessTestEnv sets the scenario env for one test and restores it after.
func keylessTestEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for k, v := range kv {
		t.Setenv(k, v)
	}
}

// fullyConfigured is the env of a correctly-enabled run, so each test can remove exactly one thing.
func fullyConfigured() map[string]string {
	return map[string]string{
		envKeylessDB:        "1",
		envKeylessDBEngine:  keylessEnginePostgres,
		envKeylessDBVersion: "16",
		envKeylessDBClass:   "db.r6g.large",
		envArgoAppsRepo:     "https://github.com/acme/apps",
		envArgoGitToken:     "ghp_notreal",
	}
}

// TestKeylessLane_DelegatesToTheProductTable is the anti-drift assertion. The lane must not know
// which clouds honour keyless — it must ASK. If this test ever needs updating because a cell opened
// or closed, the delegation has been replaced by a copy.
func TestKeylessLane_DelegatesToTheProductTable(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
		for _, engine := range []string{keylessEnginePostgres, keylessEngineMySQL} {
			state, reason, err := manifests.KeylessCell(provider, engine)
			if err != nil {
				t.Fatalf("the product table refuses %s × %s: %v", provider, engine, err)
			}
			ok, blocked := keylessLane(provider, engine)
			if want := state == manifests.KeylessCellLive; ok != want {
				t.Errorf("%s × %s: lane provable=%v but the product cell is %q", provider, engine, ok, state)
			}
			if ok {
				continue
			}
			// A blocked cell must carry the CELL's own sentence — the same string the canvas shows on
			// the disabled toggle. A lane that paraphrased would give two answers to one question.
			if !strings.Contains(blocked, reason) {
				t.Errorf("%s × %s blocked reason %q does not carry the cell's reason %q", provider, engine, blocked, reason)
			}
		}
	}
}

// TestKeylessLane_UnknownCellIsBlocked: fail-closed on a cloud or engine the product does not know,
// rather than treating an unrecognised cell as provable.
func TestKeylessLane_UnknownCellIsBlocked(t *testing.T) {
	if ok, blocked := keylessLane("nimbus", keylessEnginePostgres); ok || blocked == "" {
		t.Errorf("an unknown provider must be blocked with a reason, got ok=%v reason=%q", ok, blocked)
	}
	if ok, blocked := keylessLane("aws", "cockroach"); ok || blocked == "" {
		t.Errorf("an unknown engine must be blocked with a reason, got ok=%v reason=%q", ok, blocked)
	}
}

// TestKeylessDecide_OffIsSilent: the base T2 proof is untouched unless a maintainer opts in.
func TestKeylessDecide_OffIsSilent(t *testing.T) {
	run, blocked, err := keylessDBFromEnv("aws").decide()
	if run || blocked != "" || err != nil {
		t.Errorf("unrequested scenario must be a silent no-op, got run=%v blocked=%q err=%v", run, blocked, err)
	}
}

// TestKeylessDecide_ExcludedCloudSkipsWithTheReason: enabling the scenario on hetzner is not an
// error — it is a documented exclusion, and the run half logs the sentence rather than failing a
// nightly leg for a cell the product deliberately does not serve.
func TestKeylessDecide_ExcludedCloudSkipsWithTheReason(t *testing.T) {
	keylessTestEnv(t, fullyConfigured())
	run, blocked, err := keylessDBFromEnv("hetzner").decide()
	if err != nil {
		t.Fatalf("an excluded cloud must skip, not error: %v", err)
	}
	if run {
		t.Fatal("hetzner is an excluded cell — the scenario must not run")
	}
	if !strings.Contains(blocked, "CloudNativePG") {
		t.Errorf("the skip reason should be the product's own exclusion prose, got %q", blocked)
	}
}

// TestKeylessDecide_MissingConfigFailsBeforeSpend: a partial configuration is a LOUD error naming
// every missing key, raised before anything provisions. The alternative — discovering a missing
// instance class when `tofu apply` rejects it — costs minutes and money per leg.
func TestKeylessDecide_MissingConfigFailsBeforeSpend(t *testing.T) {
	for _, missing := range []string{envKeylessDBVersion, envKeylessDBClass} {
		env := fullyConfigured()
		env[missing] = ""
		keylessTestEnv(t, env)
		_, _, err := keylessDBFromEnv("aws").decide()
		if err == nil {
			t.Fatalf("unset %s must fail the scenario", missing)
		}
		if !strings.Contains(err.Error(), missing) {
			t.Errorf("the error must name %s, got %v", missing, err)
		}
	}
}

// TestKeylessDecide_RequiresTheAppsRepo is the precondition nobody would guess. The workload AND its
// bootstrap Job reach the cluster only through the GitOps apps repo — generateAppManifests returns
// before rendering anything when none is wired. Without this check the scenario would poll for
// objects nobody ever pushed and time out looking exactly like a keyless failure.
func TestKeylessDecide_RequiresTheAppsRepo(t *testing.T) {
	for _, missing := range []string{envArgoAppsRepo, envArgoGitToken} {
		env := fullyConfigured()
		env[missing] = ""
		keylessTestEnv(t, env)
		_, _, err := keylessDBFromEnv("aws").decide()
		if err == nil {
			t.Fatalf("unset %s must fail the scenario — nothing would render into the cluster", missing)
		}
		if !strings.Contains(err.Error(), missing) {
			t.Errorf("the error must name %s, got %v", missing, err)
		}
	}
}

// TestKeylessDecide_RejectsAnUnknownEngine: the engine is half the cell key; a typo must not resolve
// into the other engine's wiring.
func TestKeylessDecide_RejectsAnUnknownEngine(t *testing.T) {
	env := fullyConfigured()
	env[envKeylessDBEngine] = "postgres-ish"
	keylessTestEnv(t, env)
	if _, _, err := keylessDBFromEnv("aws").decide(); err == nil {
		t.Fatal("an unknown engine must be rejected")
	}
}

// TestKeylessDecide_RejectsAForeignNamespace: the per-cloud templates pin the workload-identity
// subject to `default`, so a pod anywhere else cannot federate an identity at all. Caught at
// configuration time rather than as an unexplained authentication failure in the cluster.
func TestKeylessDecide_RejectsAForeignNamespace(t *testing.T) {
	env := fullyConfigured()
	env[envKeylessDBNamespace] = "team-a"
	keylessTestEnv(t, env)
	_, _, err := keylessDBFromEnv("aws").decide()
	if err == nil || !strings.Contains(err.Error(), "workload-identity subject") {
		t.Fatalf("a foreign namespace must be refused with the reason, got %v", err)
	}
}

// TestKeylessDecide_HappyPath: a fully-configured live cell runs.
func TestKeylessDecide_HappyPath(t *testing.T) {
	keylessTestEnv(t, fullyConfigured())
	run, blocked, err := keylessDBFromEnv("aws").decide()
	if err != nil || !run || blocked != "" {
		t.Fatalf("a configured live cell must run, got run=%v blocked=%q err=%v", run, blocked, err)
	}
}

// TestKeylessPortMatchesEngine pins the wire ports the snapshot carries. A MySQL database that
// inherited 5432 would fail to connect with an error pointing nowhere near the cause.
func TestKeylessPortMatchesEngine(t *testing.T) {
	if got := keylessEnginePort(keylessEnginePostgres); got != 5432 {
		t.Errorf("postgres port = %d, want 5432", got)
	}
	if got := keylessEnginePort(keylessEngineMySQL); got != 3306 {
		t.Errorf("mysql port = %d, want 3306", got)
	}
}

// TestApplyToSnapshot_CreatesTheDatabaseAndService covers the green-floor run: no databases yet, so
// the scenario supplies one and the service that binds it.
func TestApplyToSnapshot_CreatesTheDatabaseAndService(t *testing.T) {
	keylessTestEnv(t, fullyConfigured())
	c := keylessDBFromEnv("aws")
	snap := map[string]any{}
	c.applyToSnapshot(snap)

	dbs := existingList(snap, "databases")
	if len(dbs) != 1 {
		t.Fatalf("expected exactly one database, got %v", dbs)
	}
	db := dbs[0].(map[string]any)
	if db["iam_auth"] != true {
		t.Error("the database must be marked iam_auth — the scenario has no subject otherwise")
	}
	if db["engine_family"] != keylessEnginePostgres || db["engine_version"] != "16" || db["instance_class"] != "db.r6g.large" {
		t.Errorf("engine trio not applied: %+v", db)
	}
	svcs := existingList(snap, "services")
	if len(svcs) != 1 {
		t.Fatalf("expected one service, got %v", svcs)
	}
	svc := svcs[0].(map[string]any)
	binding := svc["bindings"].([]any)[0].(map[string]any)
	if target := binding["target"].(map[string]any)["name"]; target != db["name"] {
		t.Errorf("the binding targets %v but the database is %v", target, db["name"])
	}
	// The password facet must be REQUESTED, so that asserting the pod has none means something.
	var sawPassword bool
	for _, inj := range binding["inject"].([]any) {
		if inj.(map[string]any)["from"] == "password" {
			sawPassword = true
		}
	}
	if !sawPassword {
		t.Error("the binding must ask for `password` — a pod with no password env proves nothing if nothing asked for one")
	}
}

// TestApplyToSnapshot_OverlaysDatabaseZero is the max-config composition case, and it guards a bug
// that would still look green: the AWS template reads only databases[0], so APPENDING a second
// database would provision nothing while the binding's endpoint resolved from the single per-cloud
// output — proving something about the FIRST database instead.
func TestApplyToSnapshot_OverlaysDatabaseZero(t *testing.T) {
	keylessTestEnv(t, fullyConfigured())
	c := keylessDBFromEnv("aws")
	snap := map[string]any{
		"databases": []any{map[string]any{
			"name":                  "appdb",
			"engine_family":         "postgres",
			"engine_version":        "16.6",
			"backup_retention_days": 7,
		}},
	}
	c.applyToSnapshot(snap)

	dbs := existingList(snap, "databases")
	if len(dbs) != 1 {
		t.Fatalf("the scenario must OVERLAY databases[0], not append: %v", dbs)
	}
	db := dbs[0].(map[string]any)
	if db["name"] != "appdb" {
		t.Errorf("the existing database's name must survive, got %v", db["name"])
	}
	if db["backup_retention_days"] != 7 {
		t.Error("max-config's other knobs must survive the overlay — the two dimensions compose")
	}
	if db["iam_auth"] != true || db["engine_version"] != "16" {
		t.Errorf("the scenario's own fields must win: %+v", db)
	}
	// The binding must follow the overlaid name, not the scenario's default.
	svc := existingList(snap, "services")[0].(map[string]any)
	binding := svc["bindings"].([]any)[0].(map[string]any)
	if got := binding["target"].(map[string]any)["name"]; got != "appdb" {
		t.Errorf("the binding targets %v, but the overlaid database is appdb", got)
	}
	if got := c.snapshotDBName(snap); got != "appdb" {
		t.Errorf("snapshotDBName = %q, want the overlaid name", got)
	}
}

// TestApplyToSnapshot_AppendsServices is the #1268 trap, restated: MaxConfigSnapshot assigns whole
// snapshot keys, so a layer that ASSIGNED `services` would silently drop a full-bar run's own
// surface and still report green.
func TestApplyToSnapshot_AppendsServices(t *testing.T) {
	keylessTestEnv(t, fullyConfigured())
	c := keylessDBFromEnv("aws")
	snap := map[string]any{"services": []any{map[string]any{"name": "xacct-probe"}}}
	c.applyToSnapshot(snap)
	svcs := existingList(snap, "services")
	if len(svcs) != 2 {
		t.Fatalf("the scenario must APPEND to services, got %v", svcs)
	}
	if svcs[0].(map[string]any)["name"] != "xacct-probe" {
		t.Error("an existing service was clobbered")
	}
}

// TestKeylessDecisionFor_MissingIsDistinctFromFailedClosed. These two outcomes send an operator to
// completely different places — "the render never considered the binding" versus "it considered it
// and refused" — so the lookup must not collapse them into one.
func TestKeylessDecisionFor_MissingIsDistinctFromFailedClosed(t *testing.T) {
	_, found, err := keylessDecisionFor([]byte(`{"infra_services":[]}`), "api", "orders-db")
	if err != nil {
		t.Fatal(err)
	}
	if found {
		t.Error("no keyless_bindings key must read as NOT FOUND, never as a decision")
	}

	meta := []byte(`{"keyless_bindings":[
		{"service":"other","target_kind":"database","target_name":"other-db","engine":"mysql","status":"wired","reason":"x"},
		{"service":"api","target_kind":"database","target_name":"orders-db","engine":"postgres","status":"failed_closed","reason":"Unavailable on Hetzner."}
	]}`)
	rec, found, err := keylessDecisionFor(meta, "api", "orders-db")
	if err != nil || !found {
		t.Fatalf("the matching decision was not found: found=%v err=%v", found, err)
	}
	if rec.Status != "failed_closed" || !strings.Contains(rec.Reason, "Hetzner") {
		t.Errorf("wrong decision matched: %+v", rec)
	}
}

// TestParseJobOutcome covers the three states the bootstrap Job can be in. "Neither" must keep the
// caller polling — treating an unwritten status as failure would fail every run at second zero.
func TestParseJobOutcome(t *testing.T) {
	running, err := parseJobOutcome([]byte(`{"status":{}}`))
	if err != nil || running.Succeeded || running.Failed {
		t.Errorf("an empty status is still running, got %+v (%v)", running, err)
	}
	done, err := parseJobOutcome([]byte(`{"status":{"succeeded":1,"conditions":[{"type":"Complete","status":"True","reason":"done"}]}}`))
	if err != nil || !done.Succeeded {
		t.Errorf("a Complete Job must read as succeeded, got %+v (%v)", done, err)
	}
	failed, err := parseJobOutcome([]byte(`{"status":{"failed":1,"conditions":[{"type":"Failed","status":"True","reason":"BackoffLimitExceeded","message":"PAM authentication failed"}]}}`))
	if err != nil || !failed.Failed || failed.Succeeded {
		t.Errorf("a Failed Job must read as failed and NOT succeeded, got %+v (%v)", failed, err)
	}
	// The message is the diagnosis — the bootstrap Job is where a real cloud trust error finally
	// speaks, and a verdict without it would send someone to read logs by hand.
	if !strings.Contains(failed.Detail, "PAM authentication failed") {
		t.Errorf("the failure detail must carry the cloud's message, got %q", failed.Detail)
	}
}

// TestDeploymentAvailable covers the rendered workload's readiness.
func TestDeploymentAvailable(t *testing.T) {
	if _, ok, err := deploymentAvailable([]byte(`{"status":{"conditions":[{"type":"Available","status":"True"}]}}`)); err != nil || !ok {
		t.Errorf("Available=True must read ready, got ok=%v err=%v", ok, err)
	}
	if _, ok, _ := deploymentAvailable([]byte(`{"status":{"conditions":[{"type":"Available","status":"False","reason":"MinimumReplicasUnavailable"}]}}`)); ok {
		t.Error("Available=False must not read ready")
	}
	if _, ok, _ := deploymentAvailable([]byte(`{"status":{}}`)); ok {
		t.Error("an unreconciled Deployment must not read ready")
	}
}

// deployWithPassword is a rendered pod that took the PASSWORD path — the exact regression this
// scenario exists to catch, since it renders and deploys perfectly well.
const deployWithPassword = `{"spec":{"template":{"spec":{"serviceAccountName":"default","containers":[
	{"name":"api","env":[
		{"name":"DATABASE_HOST","value":"db.abc.rds.amazonaws.com"},
		{"name":"DATABASE_PASSWORD","valueFrom":{"secretKeyRef":{"name":"api-secret-orders-db","key":"password"}}}]}]}}}}`

// deployKeyless is the keyless render: a proxy sidecar, loopback endpoint, no Secret anywhere.
const deployKeyless = `{"spec":{"template":{"spec":{"serviceAccountName":"alethia-app","containers":[
	{"name":"api","env":[
		{"name":"DATABASE_HOST","value":"127.0.0.1"},
		{"name":"DATABASE_PORT","value":"5432"},
		{"name":"DATABASE_USER","value":"alethia_app"}]},
	{"name":"db-authproxy","env":[]}]}}}}`

// TestPodTemplate_NoPasswordMaterial is the POSITIVE shape of keyless, asserted on the object the
// cluster holds. Absence of an error is not evidence; a pod with no Secret reference is.
func TestPodTemplate_NoPasswordMaterial(t *testing.T) {
	bad, err := parsePodTemplate([]byte(deployWithPassword))
	if err != nil {
		t.Fatal(err)
	}
	problems := bad.assertNoPasswordMaterial()
	if len(problems) == 0 {
		t.Fatal("a secretKeyRef'd DATABASE_PASSWORD must be reported — that IS the password path")
	}
	if !strings.Contains(problems[0], "api-secret-orders-db") {
		t.Errorf("the report must name the Secret, got %q", problems[0])
	}

	good, err := parsePodTemplate([]byte(deployKeyless))
	if err != nil {
		t.Fatal(err)
	}
	if problems := good.assertNoPasswordMaterial(); len(problems) != 0 {
		t.Errorf("the keyless render must be clean, got %v", problems)
	}
	if !good.hasContainer(keylessSidecarName) {
		t.Error("the proxy sidecar must be found by name")
	}
	if good.ServiceAccount != "alethia-app" {
		t.Errorf("the pod must run as the workload-identity KSA, got %q", good.ServiceAccount)
	}
	if host, ok := good.appEndpointEnv("api"); !ok || host != "127.0.0.1" {
		t.Errorf("a keyless app's endpoint must be the loopback proxy, got %q (found=%v)", host, ok)
	}
}

// TestKeylessProbeSQL_PerEngine: the probe writes and reads back, on both dialects.
func TestKeylessProbeSQL_PerEngine(t *testing.T) {
	pg := keylessProbeSQL(keylessEnginePostgres, "alethia_e2e_canary", "abc123")
	if !strings.Contains(pg, "ON CONFLICT") || !strings.Contains(pg, "SELECT v FROM") {
		t.Errorf("the postgres probe must upsert then read back, got %q", pg)
	}
	my := keylessProbeSQL(keylessEngineMySQL, "alethia_e2e_canary", "abc123")
	if !strings.Contains(my, "REPLACE INTO") || strings.Contains(my, "ON CONFLICT") {
		t.Errorf("the mysql probe must use the mysql dialect, got %q", my)
	}
}

// TestKeylessClientArgv_NeverPassesAPassword. There is no password to pass — the proxy authenticates
// upstream — and a client invocation that carried one would quietly turn this into a password test.
func TestKeylessClientArgv_NeverPassesAPassword(t *testing.T) {
	for _, engine := range []string{keylessEnginePostgres, keylessEngineMySQL} {
		argv := keylessClientArgv(engine, "alethia_app", "keylessdb", keylessEnginePort(engine), "SELECT 1;")
		joined := strings.Join(argv, " ")
		for _, forbidden := range []string{"--password=", "-p", "PGPASSWORD", "MYSQL_PWD"} {
			for _, arg := range argv {
				// `-p` is checked as a whole argument: `--protocol=TCP` contains it as a substring, and
				// a substring match would make this assertion permanently and silently true.
				if arg == forbidden || (strings.HasSuffix(forbidden, "=") && strings.HasPrefix(arg, forbidden)) {
					t.Errorf("%s client argv carries a password (%q): %q", engine, forbidden, joined)
				}
			}
		}
		if !strings.Contains(joined, "127.0.0.1") {
			t.Errorf("%s client must connect to the local proxy, got %q", engine, joined)
		}
	}
}

// TestParseProbeValue: the canary is the last row, and an empty result is an ERROR. Comparing an
// empty string against a digest would be a check that can never explain itself.
func TestParseProbeValue(t *testing.T) {
	v, err := parseProbeValue("CREATE TABLE\nINSERT 0 1\ndeadbeef\n")
	if err != nil || v != "deadbeef" {
		t.Errorf("got %q (%v), want the canary row", v, err)
	}
	if _, err := parseProbeValue("CREATE TABLE\n\n"); err == nil {
		t.Error("a query that returned no row must be an error — an empty success proves nothing")
	}
}

// TestKeylessSummary_CarriesNoSecrets: the proof bundle records verdicts, never the canary.
func TestKeylessSummary_CarriesNoSecrets(t *testing.T) {
	b, err := keylessSummaryJSON(keylessSummary{
		Provider: "aws", Engine: "postgres", Database: "keylessdb",
		DwellSeconds: int(keylessDefaultDwell / time.Second), Verdict: "PASS",
	})
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if !strings.Contains(s, `"feature": "keyless-db-auth"`) {
		t.Errorf("the summary must identify the feature, got %s", s)
	}
	if !strings.Contains(s, `"rotation_dwell_seconds": 960`) {
		t.Errorf("the dwell must be recorded so a run cannot claim a proof it did not perform, got %s", s)
	}
}
