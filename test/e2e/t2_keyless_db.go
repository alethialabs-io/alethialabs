// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Keyless database auth against a REAL cloud database (#1511) — the PURE half.
//
// This is the first e2e for keyless (#722) on any engine or cloud. Until it runs, keyless is proven
// only by golden unit tests: renderers that emit the right YAML. That gap is not theoretical — the
// original AWS/Azure wiring (a `db-token` file refresher in front of stock `bitnami/pgbouncer`,
// configured through PGB_* variables that image has never read) rendered perfectly and could not
// possibly have authenticated. It shipped, and nothing caught it, because no test ever opened a
// connection (#1500).
//
// So the claim this scenario makes is narrow and physical: a workload the PRODUCT rendered, holding
// no password anywhere in its pod spec, runs a query against a managed cloud database, and keeps
// working after the credential it never had would have expired.
//
// Everything here is deterministic and unit-tested without a cloud (t2_keyless_db_pure_test.go); the
// *_run_test.go sibling drives it against a real cluster under the e2e_t2 build tag.
package e2e

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
)

// Scenario env. Every per-cloud value also honours the "<base>_<PROVIDER>" override idiom
// (t2ArgoEnvForProvider), because the engine version and instance class that are valid on RDS are
// rejected by Cloud SQL and by Flexible Server — the same divergence maxconfig.go already carries.
const (
	envKeylessDB          = "ALETHIA_E2E_KEYLESS_DB"                // truthy ⇒ enable
	envKeylessDBEngine    = "ALETHIA_E2E_KEYLESS_DB_ENGINE"         // postgres | mysql
	envKeylessDBVersion   = "ALETHIA_E2E_KEYLESS_DB_ENGINE_VERSION" // per cloud × engine
	envKeylessDBClass     = "ALETHIA_E2E_KEYLESS_DB_INSTANCE_CLASS" // per cloud × engine
	envKeylessDBName      = "ALETHIA_E2E_KEYLESS_DB_NAME"           // the project database's name
	envKeylessDBService   = "ALETHIA_E2E_KEYLESS_DB_SERVICE"        // the service that binds it
	envKeylessDBImage     = "ALETHIA_E2E_KEYLESS_DB_IMAGE"          // the probe workload's image
	envKeylessDBClient    = "ALETHIA_E2E_KEYLESS_DB_CLIENT_IMAGE"   // the ephemeral SQL client image
	envKeylessDBNamespace = "ALETHIA_E2E_KEYLESS_DB_NAMESPACE"      // where the workload lands
	envKeylessDBDwell     = "ALETHIA_E2E_KEYLESS_DB_DWELL"          // token-rotation dwell
	envKeylessDBSummary   = "ALETHIA_E2E_KEYLESS_DB_SUMMARY"        // where to write the proof summary
)

// Engine families, matching types.ProjectDatabaseConfig.EngineFamily. Literals rather than an import:
// manifests keeps its own copies unexported. They are not free-floating — every one is fed to
// manifests.KeylessCell, which fails closed on an engine it does not know, so a typo here surfaces as
// a refusal rather than a silently mis-shaped database.
const (
	keylessEnginePostgres = "postgres"
	keylessEngineMySQL    = "mysql"
)

// Wire ports per engine. These mirror manifests' postgresPort/mysqlPort — a protocol constant, not
// per-cloud configuration — and exist here because the scenario writes the database's `port` into the
// snapshot. TestKeylessPortMatchesEngine pins them.
const (
	keylessPortPostgres = 5432
	keylessPortMySQL    = 3306
)

// keylessDefaultProbeImage is the app container of the probe workload. It does nothing on purpose:
// the query is run by an EPHEMERAL container injected into this pod, which shares its network
// namespace and therefore reaches the product's own proxy on 127.0.0.1. A workload that queried the
// database itself would need a client baked in, and then the test would be proving that image's
// behaviour rather than the platform's wiring.
const keylessDefaultProbeImage = "registry.k8s.io/pause:3.9"

// The default SQL clients for the ephemeral probe container, per engine.
const (
	keylessDefaultClientPostgres = "postgres:16-alpine"
	keylessDefaultClientMySQL    = "mysql:8.4"
)

// keylessDefaultDwell is how long a session is held open before it is queried again. It exceeds the
// 15-minute RDS-IAM token lifetime deliberately: the whole design claim of `db-authproxy` is that it
// mints per connection and holds nothing at rest, and a dwell shorter than the TTL would pass just as
// happily against a proxy that cached one token forever.
const keylessDefaultDwell = 16 * time.Minute

// keylessSidecarName is the container the product co-schedules for the in-process proxy clouds. The
// GCP cell uses the native Cloud SQL Auth Proxy instead, under its own name.
const (
	keylessSidecarName  = "db-authproxy"
	gcpProxySidecarName = "cloudsql-proxy"
)

// keylessDBConfig is the resolved scenario input.
type keylessDBConfig struct {
	provider      string
	engine        string
	engineVersion string
	instanceClass string
	dbName        string
	serviceName   string
	probeImage    string
	clientImage   string
	namespace     string
	summaryPath   string
	dwell         time.Duration
	enabled       bool
}

// keylessDBEnabled reports whether the opt-in scenario was requested. Off by default: the base T2
// proof is unchanged unless a maintainer opts in.
func keylessDBEnabled() bool { return t2Truthy(os.Getenv(envKeylessDB)) }

// keylessLane reports whether this cloud × engine cell can be proven, and why not when it cannot.
//
// It DELEGATES to the product's own cell table rather than keeping a list. A mirrored table would be
// a second literal describing which clouds honour keyless, and the entire lesson of that table is
// what a second literal costs: alibaba and hetzner were "excluded" for months purely by being absent
// from it, and the canvas went on offering the toggle for them (#1510). Here, an excluded cell's
// blocked-reason IS the sentence the canvas shows.
func keylessLane(provider, engine string) (ok bool, blocked string) {
	state, reason, err := manifests.KeylessCell(provider, engine)
	if err != nil {
		return false, err.Error()
	}
	switch state {
	case manifests.KeylessCellLive:
		return true, ""
	case manifests.KeylessCellPending:
		return false, fmt.Sprintf("%s × %s is not implemented yet: %s", provider, engine, reason)
	default:
		return false, reason
	}
}

// keylessDBFromEnv resolves the scenario config for a provider.
func keylessDBFromEnv(provider string) keylessDBConfig {
	engine := strings.ToLower(t2ArgoEnvForProvider(envKeylessDBEngine, provider, keylessEnginePostgres))
	c := keylessDBConfig{
		provider:      provider,
		engine:        engine,
		enabled:       keylessDBEnabled(),
		engineVersion: t2ArgoEnvForProvider(envKeylessDBVersion, provider, ""),
		instanceClass: t2ArgoEnvForProvider(envKeylessDBClass, provider, ""),
		dbName:        t2Env(envKeylessDBName, "keylessdb"),
		serviceName:   t2Env(envKeylessDBService, "keyless-probe"),
		probeImage:    t2ArgoEnvForProvider(envKeylessDBImage, provider, keylessDefaultProbeImage),
		clientImage:   t2ArgoEnvForProvider(envKeylessDBClient, provider, defaultClientImage(engine)),
		namespace:     t2Env(envKeylessDBNamespace, keylessWorkloadNamespace),
		summaryPath:   t2Env(envKeylessDBSummary, ""),
		dwell:         keylessDefaultDwell,
	}
	if d := t2Env(envKeylessDBDwell, ""); d != "" {
		if parsed, err := time.ParseDuration(d); err == nil {
			c.dwell = parsed
		}
	}
	return c
}

// keylessWorkloadNamespace is the namespace the keyless workload MUST land in. It is a constant
// mirror of manifests' keylessKSANamespace (unexported there): the per-cloud templates pin their
// WIF/federated-identity subject to that namespace, so a pod anywhere else cannot federate an
// identity at all. The env override exists for a future placement model, not as a knob.
const keylessWorkloadNamespace = "default"

// defaultClientImage picks the SQL client the ephemeral probe container runs.
func defaultClientImage(engine string) string {
	if engine == keylessEngineMySQL {
		return keylessDefaultClientMySQL
	}
	return keylessDefaultClientPostgres
}

// keylessEnginePort is the wire port for an engine family — written into the database's snapshot
// entry, so a MySQL cell does not inherit Postgres's 5432 and then fail to connect with an error
// pointing nowhere near the cause.
func keylessEnginePort(engine string) int {
	if engine == keylessEngineMySQL {
		return keylessPortMySQL
	}
	return keylessPortPostgres
}

// keylessProxyContainer names the proxy container the product co-schedules on this cloud. The
// assertion needs the name, and the two mechanisms use different ones.
func (c keylessDBConfig) keylessProxyContainer() string {
	if c.provider == "gcp" {
		return gcpProxySidecarName
	}
	return keylessSidecarName
}

// decide resolves whether the scenario runs. Mirrors secretsXacctConfig.decide:
//   - not requested                    → (false, nil), silent
//   - requested on a BLOCKED cell      → (false, nil) + the cell's own reason (the run half logs it)
//   - requested but partly configured  → ERROR naming every missing key, BEFORE any cloud spend
//
// The apps-repo requirement is the non-obvious one, and it is a HARD error rather than a skip. Both
// the workload and its bootstrap Job reach the cluster only through the GitOps apps repo —
// generateAppManifests returns before rendering anything when no repo is wired. Without it this
// scenario would poll for a Deployment and a Job that nobody ever pushed, and time out looking
// exactly like a keyless failure.
func (c keylessDBConfig) decide() (bool, string, error) {
	if !c.enabled {
		return false, "", nil
	}
	if c.engine != keylessEnginePostgres && c.engine != keylessEngineMySQL {
		return false, "", fmt.Errorf("%s must be %q or %q, got %q", envKeylessDBEngine, keylessEnginePostgres, keylessEngineMySQL, c.engine)
	}
	if ok, blocked := keylessLane(c.provider, c.engine); !ok {
		return false, blocked, nil
	}
	var missing []string
	need := func(key, v string) {
		if strings.TrimSpace(v) == "" {
			missing = append(missing, key)
		}
	}
	// Required for BOTH engines, with no default. A default would have to be a per-cloud × per-engine
	// table living here — a second copy of knowledge maxconfig.go already carries, and one that fails
	// at `tofu apply` (minutes and money in) rather than at configuration time.
	need(envKeylessDBVersion, c.engineVersion)
	need(envKeylessDBClass, c.instanceClass)
	// The GitOps repo, without which nothing renders into the cluster.
	need(envArgoAppsRepo, t2ArgoEnvForProvider(envArgoAppsRepo, c.provider, ""))
	need(envArgoGitToken, os.Getenv(envArgoGitToken))
	if len(missing) > 0 {
		sort.Strings(missing)
		return false, "", fmt.Errorf("%s is enabled for %s × %s but these are unset: %s",
			envKeylessDB, c.provider, c.engine, strings.Join(missing, ", "))
	}
	if c.namespace != keylessWorkloadNamespace {
		return false, "", fmt.Errorf("%s must be %q — the per-cloud templates pin the workload-identity subject to that namespace, so a pod elsewhere cannot federate an identity (got %q)",
			envKeylessDBNamespace, keylessWorkloadNamespace, c.namespace)
	}
	if c.dwell <= 0 {
		return false, "", fmt.Errorf("%s must be a positive duration, got %q", envKeylessDBDwell, c.dwell)
	}
	return true, "", nil
}

// applyToSnapshot layers the scenario onto a DEPLOY config_snapshot: a keyless-marked database, plus
// the service whose binding makes the product render the proxy sidecar and the bootstrap Job.
//
// The database OVERLAYS databases[0] rather than appending. Appending would be wrong in a way that
// still looks green: the AWS template reads only databases[0], so a second entry provisions nothing,
// while the binding's endpoint facet resolves from the single per-cloud database output — pointing
// the proxy at the FIRST database and proving nothing about the one the scenario marked. Overlaying
// also preserves every other knob a max-config run set (capacity, backup retention), so the two
// dimensions compose instead of clobbering each other.
//
// The service APPENDS, for the reason #1268 documents: MaxConfigSnapshot assigns whole snapshot keys,
// so anything that assigns `services` after it would silently drop a full-bar run's own surface.
func (c keylessDBConfig) applyToSnapshot(snap map[string]any) {
	dbs := existingList(snap, "databases")
	db := map[string]any{}
	if len(dbs) > 0 {
		if first, ok := dbs[0].(map[string]any); ok {
			db = first
		}
	}
	if _, ok := db["name"]; !ok {
		db["name"] = c.dbName
	}
	// The fields the scenario OWNS. iam_auth is the whole point; the engine trio must move together,
	// because a version and class valid for Postgres are rejected outright by the same cloud's MySQL.
	db["engine_family"] = c.engine
	db["engine_version"] = c.engineVersion
	db["instance_class"] = c.instanceClass
	db["port"] = keylessEnginePort(c.engine)
	db["iam_auth"] = true
	if len(dbs) == 0 {
		dbs = []any{db}
	} else {
		dbs[0] = db
	}
	snap["databases"] = dbs
	// The scenario reads the database's name back off the snapshot: on a max-config run the entry it
	// overlaid already had one, and the binding must target THAT name or resolve nothing.
	name, _ := db["name"].(string)

	svc := map[string]any{
		"name":   c.serviceName,
		"type":   "deployment",
		"source": map[string]any{"kind": "image", "image": c.probeImage},
		"bindings": []any{map[string]any{
			"target": map[string]any{"kind": "database", "name": name},
			"inject": []any{
				map[string]any{"env": "DATABASE_HOST", "from": "endpoint"},
				map[string]any{"env": "DATABASE_PORT", "from": "port"},
				map[string]any{"env": "DATABASE_USER", "from": "username"},
				// `password` is injected DELIBERATELY. On the keyless path the renderer drops it —
				// there is no secret to reference — so asking for it and then asserting the pod has no
				// password env is what makes the assertion meaningful. Omitting it would let a pod
				// with a password env pass simply because nothing requested one.
				map[string]any{"env": "DATABASE_PASSWORD", "from": "password"},
			},
		}},
	}
	snap["services"] = append(existingList(snap, "services"), svc)
}

// snapshotDBName reports the database name the binding targets after applyToSnapshot — the overlaid
// entry's own name, which on a max-config run is maxconfig's, not this scenario's default.
func (c keylessDBConfig) snapshotDBName(snap map[string]any) string {
	dbs := existingList(snap, "databases")
	if len(dbs) > 0 {
		if first, ok := dbs[0].(map[string]any); ok {
			if n, ok := first["name"].(string); ok && n != "" {
				return n
			}
		}
	}
	return c.dbName
}

// ── the decision record (#1511 assertion (a)) ─────────────────────────────────────────────────

// keylessDecisionRecord mirrors manifests.KeylessBindingDecision as the runner persists it. Decoded
// structurally rather than imported so a shape change on either side surfaces here as an empty
// decision — which this scenario treats as a hard failure, not a pass.
type keylessDecisionRecord struct {
	Service    string `json:"service"`
	TargetKind string `json:"target_kind"`
	TargetName string `json:"target_name"`
	Engine     string `json:"engine"`
	Status     string `json:"status"`
	Reason     string `json:"reason"`
}

// keylessDecisionFor pulls this scenario's binding decision out of execution_metadata.
//
// A MISSING decision is its own distinct outcome, and the caller must not conflate it with a
// fail-closed one: it means the render never considered the binding at all (the dark flag off, the
// service skipped as unbuilt, the apps repo not wired), whereas fail_closed means it considered it
// and refused. Those two send an operator to completely different places.
func keylessDecisionFor(metaRaw []byte, service, dbName string) (rec keylessDecisionRecord, found bool, err error) {
	var meta struct {
		KeylessBindings []keylessDecisionRecord `json:"keyless_bindings"`
	}
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		return keylessDecisionRecord{}, false, fmt.Errorf("decode execution_metadata: %w", err)
	}
	for _, d := range meta.KeylessBindings {
		if d.TargetName == dbName && (service == "" || d.Service == service) {
			return d, true, nil
		}
	}
	return keylessDecisionRecord{}, false, nil
}

// ── in-cluster observation (pure parsers over kubectl -o json output) ──────────────────────────

// kubeCondition is one status condition, in the shape Deployments and Jobs share.
type kubeCondition struct {
	Type    string `json:"type"`
	Status  string `json:"status"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

// jobOutcome is a bootstrap Job's terminal state.
type jobOutcome struct {
	Succeeded bool
	Failed    bool
	Detail    string
}

// parseJobOutcome reads a batch/v1 Job's status. Neither succeeded nor failed means "still running" —
// the caller keeps polling. A Failed condition is reported with its message: the bootstrap Job is
// where a real cloud trust misconfiguration finally speaks (an IAM policy that does not cover the
// login, an Entra admin that was never set), and that message is the whole diagnosis.
func parseJobOutcome(objJSON []byte) (jobOutcome, error) {
	var obj struct {
		Status struct {
			Succeeded  int             `json:"succeeded"`
			Failed     int             `json:"failed"`
			Conditions []kubeCondition `json:"conditions"`
		} `json:"status"`
	}
	if err := json.Unmarshal(objJSON, &obj); err != nil {
		return jobOutcome{}, fmt.Errorf("decode Job: %w", err)
	}
	out := jobOutcome{}
	for _, c := range obj.Status.Conditions {
		if c.Status != "True" {
			continue
		}
		switch c.Type {
		case "Complete":
			out.Succeeded = true
			out.Detail = c.Reason
		case "Failed":
			out.Failed = true
			out.Detail = c.Reason + ": " + c.Message
		}
	}
	// The counters are the fallback for a Job whose conditions have not been written yet.
	if !out.Succeeded && obj.Status.Succeeded > 0 {
		out.Succeeded = true
	}
	if !out.Failed && obj.Status.Failed > 0 {
		out.Failed = true
		if out.Detail == "" {
			out.Detail = fmt.Sprintf("%d failed pod(s)", obj.Status.Failed)
		}
	}
	return out, nil
}

// deploymentAvailable reports whether a Deployment's Available condition is True.
func deploymentAvailable(objJSON []byte) (cond kubeCondition, ok bool, err error) {
	var obj struct {
		Status struct {
			Conditions []kubeCondition `json:"conditions"`
		} `json:"status"`
	}
	if err := json.Unmarshal(objJSON, &obj); err != nil {
		return kubeCondition{}, false, fmt.Errorf("decode Deployment: %w", err)
	}
	for _, c := range obj.Status.Conditions {
		if c.Type == "Available" {
			return c, c.Status == "True", nil
		}
	}
	return kubeCondition{}, false, nil
}

// podTemplate is the slice of a Deployment this scenario asserts against.
type podTemplate struct {
	Containers     []podContainer
	ServiceAccount string
}

// podContainer is one container of the rendered pod. Image and Args are carried because the negative
// control re-runs the PRODUCT's own proxy container verbatim under a different identity — see
// buildUnscopedProxyProbePod.
type podContainer struct {
	Name  string
	Image string
	Args  []string
	Env   []podEnv
}

// podEnv is one env var — a literal value, or a reference into a Secret.
type podEnv struct {
	Name          string
	Value         string
	FromSecret    string
	FromSecretKey string
}

// parsePodTemplate extracts the containers + service account from a Deployment.
func parsePodTemplate(objJSON []byte) (podTemplate, error) {
	var obj struct {
		Spec struct {
			Template struct {
				Spec struct {
					ServiceAccountName string `json:"serviceAccountName"`
					Containers         []struct {
						Name  string   `json:"name"`
						Image string   `json:"image"`
						Args  []string `json:"args"`
						Env   []struct {
							Name      string `json:"name"`
							Value     string `json:"value"`
							ValueFrom *struct {
								SecretKeyRef *struct {
									Name string `json:"name"`
									Key  string `json:"key"`
								} `json:"secretKeyRef"`
							} `json:"valueFrom"`
						} `json:"env"`
					} `json:"containers"`
				} `json:"spec"`
			} `json:"template"`
		} `json:"spec"`
	}
	if err := json.Unmarshal(objJSON, &obj); err != nil {
		return podTemplate{}, fmt.Errorf("decode Deployment pod template: %w", err)
	}
	t := podTemplate{ServiceAccount: obj.Spec.Template.Spec.ServiceAccountName}
	for _, c := range obj.Spec.Template.Spec.Containers {
		pc := podContainer{Name: c.Name, Image: c.Image, Args: c.Args}
		for _, e := range c.Env {
			pe := podEnv{Name: e.Name, Value: e.Value}
			if e.ValueFrom != nil && e.ValueFrom.SecretKeyRef != nil {
				pe.FromSecret = e.ValueFrom.SecretKeyRef.Name
				pe.FromSecretKey = e.ValueFrom.SecretKeyRef.Key
			}
			pc.Env = append(pc.Env, pe)
		}
		t.Containers = append(t.Containers, pc)
	}
	return t, nil
}

// container returns the pod's container by name.
func (t podTemplate) container(name string) (podContainer, bool) {
	for _, c := range t.Containers {
		if c.Name == name {
			return c, true
		}
	}
	return podContainer{}, false
}

// hasContainer reports whether the pod carries a container by name.
func (t podTemplate) hasContainer(name string) bool {
	_, ok := t.container(name)
	return ok
}

// buildUnscopedProxyProbePod renders the NEGATIVE control: the product's OWN proxy container, copied
// verbatim — same image, same args, same address — beside a SQL client, in a pod running on the
// namespace's default ServiceAccount.
//
// Copying the container rather than dialing the database directly is what makes this control sharp
// and cloud-uniform. Only ONE variable changes: the identity. There is no annotation for GKE or EKS
// to federate, and no `azure.workload.identity/use` label for the Azure webhook to act on, so the
// proxy has nothing to mint a token from. A direct connection instead would have needed the database
// host, which means a second copy of the per-cloud endpoint output keys — and on GCP it is not even
// expressible, since the Cloud SQL proxy takes an instance connection name rather than an address.
//
// If this pod CAN read the canary, the database accepts a connection from any pod in the cluster and
// the positive proof above degenerates into "a database was reachable".
func buildUnscopedProxyProbePod(name, ns, clientImage string, proxy podContainer) string {
	var args strings.Builder
	for _, a := range proxy.Args {
		fmt.Fprintf(&args, "\n        - %q", a)
	}
	return fmt.Sprintf(`apiVersion: v1
kind: Pod
metadata:
  name: %s
  namespace: %s
spec:
  restartPolicy: Never
  serviceAccountName: default
  containers:
    - name: client
      image: %s
      command: ["sleep", "900"]
    - name: %s
      image: %s
      args:%s
`, name, ns, clientImage, proxy.Name, proxy.Image, args.String())
}

// assertNoPasswordMaterial is the POSITIVE shape of "keyless", checked on the object the cluster
// actually holds rather than inferred from the absence of an error.
//
// Two things must be true and they fail differently: no env may reference a Secret (a secretKeyRef is
// the password path, and its presence means the binding silently took it), and no env may carry a
// literal that looks like a credential. The endpoint check is included because a keyless workload's
// endpoint MUST be the loopback proxy — a pod pointed straight at the cloud database would be
// connecting with something, and whatever that is, it is not this design.
func (t podTemplate) assertNoPasswordMaterial() []string {
	var problems []string
	for _, c := range t.Containers {
		for _, e := range c.Env {
			if e.FromSecret != "" {
				problems = append(problems, fmt.Sprintf(
					"container %s env %s reads Secret %s/%s — a keyless workload must reference no Secret at all",
					c.Name, e.Name, e.FromSecret, e.FromSecretKey))
				continue
			}
			if strings.Contains(strings.ToUpper(e.Name), "PASSWORD") && e.Value != "" {
				problems = append(problems, fmt.Sprintf(
					"container %s has a non-empty %s literal — the renderer must DROP the password facet, not fill it",
					c.Name, e.Name))
			}
		}
	}
	return problems
}

// appEndpointEnv returns the DATABASE_HOST the app container was given.
func (t podTemplate) appEndpointEnv(appContainer string) (string, bool) {
	for _, c := range t.Containers {
		if c.Name != appContainer {
			continue
		}
		for _, e := range c.Env {
			if e.Name == "DATABASE_HOST" {
				return e.Value, true
			}
		}
	}
	return "", false
}

// ── the password-free query ───────────────────────────────────────────────────────────────────

// keylessProbeSQL renders the query the ephemeral client runs: create a table, write a canary, read
// it back. The value is compared as a sha256 by the CALLER, so a connection that succeeds but returns
// nothing cannot pass — "the query ran" and "the query returned our row" are different claims, and
// only the second one proves a working session.
//
// The canary is generated per run and never logged.
func keylessProbeSQL(engine, table, canary string) string {
	if engine == keylessEngineMySQL {
		return fmt.Sprintf(
			"CREATE TABLE IF NOT EXISTS %s (k VARCHAR(64) PRIMARY KEY, v VARCHAR(128)); "+
				"REPLACE INTO %s (k, v) VALUES ('canary', '%s'); "+
				"SELECT v FROM %s WHERE k = 'canary';",
			table, table, canary, table)
	}
	return fmt.Sprintf(
		"CREATE TABLE IF NOT EXISTS %s (k text PRIMARY KEY, v text); "+
			"INSERT INTO %s (k, v) VALUES ('canary', '%s') ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v; "+
			"SELECT v FROM %s WHERE k = 'canary';",
		table, table, canary, table)
}

// keylessClientArgv builds the client invocation for the ephemeral probe container. No password is
// passed and none is available: the proxy on 127.0.0.1 accepts the local connection and authenticates
// upstream itself, which is the property under test.
func keylessClientArgv(engine, user, dbName string, port int, sql string) []string {
	if engine == keylessEngineMySQL {
		return []string{
			"mysql", "--protocol=TCP", "--host=127.0.0.1", fmt.Sprintf("--port=%d", port),
			"--user=" + user, "--database=" + dbName, "--batch", "--skip-column-names", "--execute=" + sql,
		}
	}
	return []string{
		"psql", "--host=127.0.0.1", fmt.Sprintf("--port=%d", port),
		"--username=" + user, "--dbname=" + dbName,
		"--no-password", "--tuples-only", "--no-align", "--command=" + sql,
	}
}

// parseProbeValue pulls the canary out of the client's stdout. Both clients print the selected value
// on its own line; everything else (NOTICE lines, CREATE TABLE acknowledgements) is discarded.
//
// The LAST non-empty line is the answer, and an empty result is an error rather than an empty string:
// comparing "" against a digest would be a comparison that can never fail informatively.
func parseProbeValue(stdout string) (string, error) {
	lines := strings.Split(strings.TrimSpace(stdout), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		v := strings.TrimSpace(lines[i])
		if v == "" {
			continue
		}
		// Client chatter, not a row.
		if strings.HasPrefix(v, "CREATE") || strings.HasPrefix(v, "INSERT") ||
			strings.HasPrefix(v, "NOTICE") || strings.HasPrefix(v, "Query OK") ||
			strings.HasPrefix(v, "REPLACE") || v == "v" {
			continue
		}
		return v, nil
	}
	return "", fmt.Errorf("the query returned no row — a connection that reads nothing proves nothing")
}

// ── proof summary ─────────────────────────────────────────────────────────────────────────────

// keylessSummary is the machine-readable record folded into the proof bundle. Names, verdicts and
// durations only — never the canary, never a token.
type keylessSummary struct {
	Feature        string `json:"feature"`
	Provider       string `json:"provider"`
	Engine         string `json:"engine"`
	Database       string `json:"database"`
	Service        string `json:"service"`
	Mechanism      string `json:"mechanism,omitempty"`
	DecisionWired  bool   `json:"decision_wired"`
	BootstrapRan   bool   `json:"bootstrap_job_complete"`
	WorkloadReady  bool   `json:"workload_ready"`
	NoPasswordSeen bool   `json:"no_password_material"`
	QueryPassed    bool   `json:"password_free_query"`
	DwellSeconds   int    `json:"rotation_dwell_seconds"`
	SurvivedDwell  bool   `json:"session_survived_token_ttl"`
	FreshMintOK    bool   `json:"new_connection_after_dwell"`
	ScopeDenied    bool   `json:"unscoped_identity_denied"`
	Verdict        string `json:"verdict"`
	Detail         string `json:"detail,omitempty"`
}

// keylessSummaryJSON renders the summary for the proof bundle.
func keylessSummaryJSON(s keylessSummary) ([]byte, error) {
	s.Feature = "keyless-db-auth"
	return json.MarshalIndent(s, "", "  ")
}
