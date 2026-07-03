/* Alethia platform UI kit — screen content. */
const S_VX = window.VertexDesignSystem_8c015f;
const { Button: SBtn, Badge: SBadge, StatusBadge: SStatus, Card: SCard, CardHeader: SCH, CardTitle: SCT, CardDescription: SCD, CardBody: SCB, CardFooter: SCF, Input: SInput, Field: SField, Label: SLabel, Hint: SHint, Select: SSelect, Switch: SSwitch, Checkbox: SCheck, Radio: SRadio, Tabs: STabs, Separator: SSep, Alert: SAlert } = S_VX;
const SIc = window.VxIcons;
const { Provider: SProvider } = window.VxApp;
const eb = window.VxApp.eyebrow, mn = window.VxApp.mono;

const PageHead = ({ title, sub, action }) => (
  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 26 }}>
    <div>
      <h1 style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", margin: 0, color: "var(--text-primary)" }}>{title}</h1>
      <p style={{ color: "var(--text-tertiary)", fontSize: 14, margin: "6px 0 0" }}>{sub}</p>
    </div>
    {action}
  </div>
);
const SectionLabel = ({ children, right }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
    <span style={eb}>{children}</span>{right}
  </div>
);

/* ---------- Overview ---------- */
function Overview() {
  const stats = [["Leaf", 6, "Vines"], ["Check", 4, "Active"], ["Workflow", 2, "Tendrils online"], ["Jobs", 38, "Total jobs"]];
  const jobs = [
    ["Deploy", "active", "api-backend", "aws", "prod-worker", "2m ago", "12m 34s"],
    ["Plan", "active", "web-frontend", "gcp", "prod-worker", "18m ago", "1m 12s"],
    ["Deploy", "processing", "data-pipeline", "azure", "eu-worker", "24m ago", "4m 02s"],
    ["Destroy", "failed", "legacy-api", "aws", "prod-worker", "1h ago", "3m 41s"],
    ["Fetch Resources", "queued", "—", null, "eu-worker", "1h ago", "—"],
  ];
  return (
    <div>
      <PageHead title="Overview" sub="Your infrastructure at a glance." action={<SBtn variant="primary" size="sm"><SIc.Plus size={15} />Plant a Vine</SBtn>} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 30 }}>
        {stats.map(([ic, val, label]) => {
          const I = SIc[ic];
          return (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: "12px 14px", background: "var(--surface)" }}>
              <span style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: "var(--radius-sm)", background: "var(--surface-muted)", color: "var(--text-secondary)" }}><I size={15} /></span>
              <div><p style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em", fontFamily: "var(--font-display)", color: "var(--text-primary)" }}>{val}</p><p style={{ margin: 0, fontSize: 11, color: "var(--text-tertiary)" }}>{label}</p></div>
            </div>
          );
        })}
      </div>
      <div style={{ marginBottom: 30 }}>
        <SectionLabel right={<SBtn variant="link" size="sm" style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Manage</SBtn>}>Integrations</SectionLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {[["aws", "AWS", "acct 4471-…"], ["gcp", "GCP", "alethia-prod"]].map(([id, n, d]) => (
            <span key={id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", border: "1px solid var(--border)", background: "var(--surface)", fontSize: 12 }}>
              <SProvider id={id} size={15} /><span style={{ fontWeight: 500, color: "var(--text-primary)" }}>{n}</span><span style={{ color: "var(--text-tertiary)", ...mn, fontSize: 11 }}>{d}</span>
            </span>
          ))}
          {[["azure", "Azure"], ["datadog", "Datadog"]].map(([id, n]) => (
            <span key={id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", border: "1px dashed var(--border-strong)", fontSize: 12, color: "var(--text-tertiary)" }}>
              <img src={`../../assets/${id === "azure" ? "providers" : "integrations"}/${id}.png`} width={14} height={14} style={{ objectFit: "contain", opacity: 0.6 }} /><span>{n}</span><span style={{ fontSize: 10 }}>Connect</span>
            </span>
          ))}
        </div>
      </div>
      <div>
        <SectionLabel right={<SBtn variant="link" size="sm" style={{ fontSize: 11, color: "var(--text-tertiary)" }}>View all</SBtn>}>Recent jobs</SectionLabel>
        <JobsTable rows={jobs} />
      </div>
    </div>
  );
}

/* ---------- Jobs table (shared) ---------- */
function JobsTable({ rows }) {
  const cols = ["Type", "Status", "Vine", "Tendril", "Created", "Duration"];
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)", overflow: "hidden", background: "var(--surface)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1.3fr 1fr 1fr 0.9fr", padding: "9px 16px", borderBottom: "1px solid var(--border)", background: "var(--surface-muted)" }}>
        {cols.map((c) => <span key={c} style={{ ...eb, fontSize: 9.5 }}>{c}</span>)}
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1.3fr 1fr 1fr 0.9fr", alignItems: "center", padding: "11px 16px", borderBottom: i < rows.length - 1 ? "1px solid var(--border-faint)" : "none" }}>
          <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text-primary)" }}>{r[0]}</span>
          <span><SStatus status={r[1]} /></span>
          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>{r[3] ? <SProvider id={r[3]} size={14} /> : null}{r[2]}</span>
          <span style={{ fontSize: 12, color: "var(--text-secondary)", ...mn }}>{r[4]}</span>
          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{r[5]}</span>
          <span style={{ fontSize: 12, color: "var(--text-tertiary)", ...mn }}>{r[6]}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- Clusters ---------- */
function Clusters() {
  const data = [
    ["api-backend", "aws", "EKS", "1.31", "eu-west-1", "active", 3, "$847"],
    ["web-frontend", "gcp", "GKE Autopilot", "1.30", "us-central1", "active", 5, "$612"],
    ["data-pipeline", "azure", "AKS", "1.30", "westeurope", "processing", 4, "$408"],
    ["ml-training", "aws", "EKS", "1.31", "us-east-1", "idle", 0, "$0"],
  ];
  return (
    <div>
      <PageHead title="Clusters" sub="Kubernetes clusters provisioned across every connected cloud." action={<SBtn variant="outline" size="sm"><SIc.Plus size={15} />New cluster</SBtn>} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {data.map(([name, prov, kind, ver, region, status, nodes, cost]) => (
          <SCard key={name} interactive>
            <SCB>
              <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 16 }}>
                <span style={{ display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--surface-muted)" }}><SProvider id={prov} size={18} /></span>
                <div style={{ flex: 1 }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 600, fontFamily: "var(--font-display)", color: "var(--text-primary)" }}>{name}</p>
                  <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-tertiary)", ...mn }}>{kind} · {region}</p>
                </div>
                <SStatus status={status} />
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <SBadge variant="outline" mono>k8s {ver}</SBadge>
                <SBadge variant="muted">{nodes} {nodes === 1 ? "node" : "nodes"}</SBadge>
                <SBadge variant="muted">{cost}/mo</SBadge>
              </div>
            </SCB>
            <SCF style={{ borderTop: "1px solid var(--border-faint)", paddingTop: 12 }}>
              <SBtn variant="outline" size="sm">Open</SBtn>
              <SBtn variant="ghost" size="sm">kubeconfig</SBtn>
            </SCF>
          </SCard>
        ))}
      </div>
    </div>
  );
}

/* ---------- Jobs ---------- */
function Jobs() {
  const [tab, setTab] = React.useState("all");
  const rows = [
    ["Deploy", "active", "api-backend", "aws", "prod-worker", "2m ago", "12m 34s"],
    ["Plan", "active", "web-frontend", "gcp", "prod-worker", "18m ago", "1m 12s"],
    ["Deploy", "processing", "data-pipeline", "azure", "eu-worker", "24m ago", "4m 02s"],
    ["Connection Test", "active", "—", "gcp", "eu-worker", "40m ago", "8s"],
    ["Destroy", "failed", "legacy-api", "aws", "prod-worker", "1h ago", "3m 41s"],
    ["Fetch Resources", "queued", "—", null, "eu-worker", "1h ago", "—"],
    ["Deploy Tendril", "active", "—", "azure", "eu-worker", "3h ago", "2m 05s"],
  ];
  return (
    <div>
      <PageHead title="Jobs" sub="Every plan, deploy, and teardown across your vineyards." />
      <div style={{ marginBottom: 16 }}>
        <STabs variant="pill" tabs={[{ id: "all", label: "All" }, { id: "running", label: "Running" }, { id: "failed", label: "Failed" }]} value={tab} onValueChange={setTab} />
      </div>
      <JobsTable rows={rows} />
    </div>
  );
}

/* ---------- Plant a Vine ---------- */
function PlantVine() {
  const [section, setSection] = React.useState("cluster");
  const sections = [["network", "Network", "Network"], ["cluster", "Cluster", "Cpu"], ["database", "Database", "Database"], ["cache", "Cache", "Layers"], ["dns", "DNS", "Globe"], ["secrets", "Secrets", "Key"]];
  return (
    <div>
      <PageHead title="Plant a Vine" sub="Eleven guided sections compile into a single Terraform plan." action={<SBadge variant="outline" mono>production · api-backend</SBadge>} />
      <div style={{ display: "grid", gridTemplateColumns: "190px 1fr 240px", gap: 24, alignItems: "start" }}>
        {/* section rail */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {sections.map(([id, label, icon], i) => {
            const I = SIc[icon]; const on = section === id; const done = i < sections.findIndex((s) => s[0] === section);
            return (
              <button key={id} onClick={() => setSection(id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: "var(--radius-sm)", border: "none", cursor: "pointer", textAlign: "left", background: on ? "var(--surface-muted)" : "transparent", color: on ? "var(--text-primary)" : "var(--text-tertiary)", fontSize: 13, fontWeight: 500, fontFamily: "var(--font-sans)" }}>
                <I size={15} />{label}
                {done && <SIc.Check size={13} style={{ marginLeft: "auto", color: "var(--text-secondary)" }} />}
              </button>
            );
          })}
        </div>
        {/* fields */}
        <SCard>
          <SCH><SCT>Cluster</SCT><SCD>Control plane, node pools, and autoscaling.</SCD></SCH>
          <SCB style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <SField><SLabel>Kubernetes version</SLabel><SSelect options={["1.31", "1.30", "1.29"]} defaultValue="1.31" /></SField>
            <SField><SLabel>Instance type</SLabel><SSelect options={["m5.large", "m5.xlarge", "c6i.2xlarge"]} defaultValue="m5.large" /></SField>
            <SField><SLabel>Min nodes</SLabel><SInput mono defaultValue="2" /></SField>
            <SField><SLabel>Max nodes</SLabel><SInput mono defaultValue="10" /></SField>
            <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 12, marginTop: 4 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-secondary)" }}><SSwitch defaultChecked /> Karpenter autoscaling</label>
              <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-secondary)" }}><SSwitch defaultChecked /> ArgoCD bootstrap (GitOps)</label>
              <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-secondary)" }}><SSwitch /> Private API endpoint only</label>
            </div>
          </SCB>
          <SCF style={{ justifyContent: "space-between", borderTop: "1px solid var(--border-faint)", paddingTop: 14 }}>
            <SBtn variant="ghost" size="sm">Back</SBtn>
            <SBtn variant="primary" size="sm">Continue<SIc.ArrowRight size={15} /></SBtn>
          </SCF>
        </SCard>
        {/* cost sidebar */}
        <div style={{ position: "sticky", top: 0, display: "flex", flexDirection: "column", gap: 14 }}>
          <SCard flat style={{ background: "var(--surface-muted)" }}>
            <SCB>
              <p style={{ ...eb, margin: "0 0 12px" }}>Estimated monthly</p>
              <p style={{ fontFamily: "var(--font-display)", fontSize: 30, fontWeight: 600, letterSpacing: "-0.03em", margin: 0, color: "var(--text-primary)" }}>$847<span style={{ fontSize: 16, color: "var(--text-tertiary)" }}>.23</span></p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
                {[["EKS cluster", "$219"], ["Aurora DB", "$412"], ["ElastiCache", "$156"], ["NAT + DNS", "$33"], ["Other", "$27"]].map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}><span style={{ color: "var(--text-tertiary)" }}>{k}</span><span style={{ ...mn, color: "var(--text-secondary)" }}>{v}</span></div>
                ))}
              </div>
            </SCB>
          </SCard>
          <SAlert title="Zero credentials stored" icon={<SIc.Shield size={16} />}>Provisioned via a cross-account IAM role.</SAlert>
        </div>
      </div>
    </div>
  );
}

/* ---------- Integrations ---------- */
function Integrations() {
  const items = [
    ["aws", "providers", "AWS", "Cross-account IAM role", true],
    ["gcp", "providers", "Google Cloud", "Workload Identity Federation", true],
    ["azure", "providers", "Azure", "Federated identity", false],
    ["github", "integrations", "GitHub", "Repository sync & GitOps", true],
    ["datadog", "integrations", "Datadog", "Metrics & monitoring", false],
    ["grafana", "integrations", "Grafana", "Dashboards", false],
    ["cloudflare", "integrations", "Cloudflare", "DNS & WAF", false],
    ["prometheus", "integrations", "Prometheus", "Scrape targets", false],
  ];
  return (
    <div>
      <PageHead title="Integrations" sub="Connect cloud accounts and tooling. No static keys are ever stored." />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
        {items.map(([id, dir, name, desc, connected]) => (
          <SCard key={id} interactive>
            <SCB>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <span style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--surface-muted)" }}><img src={`../../assets/${dir}/${id}.png`} width={18} height={18} style={{ objectFit: "contain" }} /></span>
                {connected ? <SStatus status="active">Connected</SStatus> : null}
              </div>
              <p style={{ margin: "0 0 3px", fontSize: 14, fontWeight: 600, fontFamily: "var(--font-display)", color: "var(--text-primary)" }}>{name}</p>
              <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.4 }}>{desc}</p>
              <SBtn variant={connected ? "ghost" : "outline"} size="sm" style={{ width: "100%" }}>{connected ? "Manage" : "Connect"}</SBtn>
            </SCB>
          </SCard>
        ))}
      </div>
    </div>
  );
}

/* ---------- Tendrils ---------- */
function Tendrils() {
  const rows = [["prod-worker", "active", "AWS · eu-west-1", "cloud-hosted", "v1.4.2", "47 jobs"], ["eu-worker", "active", "Azure · westeurope", "self-hosted", "v1.4.2", "23 jobs"], ["staging-worker", "idle", "GCP · us-central1", "self-hosted", "v1.3.9", "8 jobs"]];
  return (
    <div>
      <PageHead title="Tendrils" sub="Provisioning workers that claim jobs and run Terraform." action={<SBtn variant="outline" size="sm"><SIc.Plus size={15} />Register tendril</SBtn>} />
      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)", overflow: "hidden", background: "var(--surface)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1.4fr 1fr 0.8fr 0.8fr", padding: "9px 16px", borderBottom: "1px solid var(--border)", background: "var(--surface-muted)" }}>
          {["Tendril", "Status", "Region", "Mode", "Version", "Throughput"].map((c) => <span key={c} style={{ ...eb, fontSize: 9.5 }}>{c}</span>)}
        </div>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1.4fr 1fr 0.8fr 0.8fr", alignItems: "center", padding: "12px 16px", borderBottom: i < rows.length - 1 ? "1px solid var(--border-faint)" : "none" }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", ...mn }}>{r[0]}</span>
            <SStatus status={r[1]} />
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{r[2]}</span>
            <span><SBadge variant="muted">{r[3]}</SBadge></span>
            <span style={{ fontSize: 12, color: "var(--text-tertiary)", ...mn }}>{r[4]}</span>
            <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{r[5]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

window.VxScreens = { Overview, Clusters, Jobs, PlantVine, Integrations, Tendrils };
