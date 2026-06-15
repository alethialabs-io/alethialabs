/* Alethia Web UI kit — marketing landing recreation. */
const W = window.VertexDesignSystem_8c015f;
const { Button: WBtn, Badge: WBadge, Tabs: WTabs, Card: WCard, CardBody: WCB, Separator: WSep } = W;

const WMark = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ display: "block" }}>
    <path d="M4 25.5 L16 6 L28 25.5" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
    <path d="M10.5 25.5 L16 16.5 L21.5 25.5" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" opacity="0.4" />
    <rect x="13.4" y="3.4" width="5.2" height="5.2" rx="1.1" transform="rotate(45 16 6)" fill="currentColor" />
  </svg>
);
const Arrow = ({ size = 15 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>;
const ebw = { fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--text-tertiary)" };
const wmono = { fontFamily: "var(--font-mono)" };
const Wrap = ({ children, style }) => <div style={{ maxWidth: 1080, margin: "0 auto", padding: "0 32px", ...style }}>{children}</div>;

/* ---- Header ---- */
function Header() {
  const links = ["Features", "CLI", "Ecosystem", "Docs"];
  return (
    <header style={{ position: "sticky", top: 0, zIndex: 40, borderBottom: "1px solid var(--border)", background: "color-mix(in oklch, var(--canvas) 82%, transparent)", backdropFilter: "blur(10px)" }}>
      <Wrap style={{ height: 60, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, color: "var(--text-primary)" }}>
          <WMark size={24} /><span style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" }}>Alethia</span>
          <span style={{ ...ebw, fontSize: 9, marginLeft: 6, opacity: 0.7 }}>by Alethia</span>
        </div>
        <nav style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {links.map((l) => <a key={l} href="#" style={{ padding: "6px 12px", fontSize: 13.5, color: "var(--text-tertiary)", borderRadius: "var(--radius-sm)" }}>{l}</a>)}
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <a href="#" style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13.5, color: "var(--text-tertiary)" }}><img src="../../assets/integrations/github.png" width={16} height={16} style={{ filter: "grayscale(1) invert(0.85)" }} />GitHub</a>
          <WBtn variant="primary" size="sm">Get started</WBtn>
        </div>
      </Wrap>
    </header>
  );
}

/* ---- Terminal demo ---- */
const DEMO = {
  aws: {
    plan: ["$ vertex plan", "", "  ▸ Terraform plan…", "  47 resources to add", "  0 to change, 0 to destroy", "", "  Estimated  $847.23/mo"],
    deploy: ["$ vertex deploy", "", "  ✓ aws_vpc.main", "  ✓ aws_eks_cluster.main   v1.31", "  ✓ aws_rds_cluster.main    aurora", "  ✓ helm_release.argocd     v2.12", "  … +43 more", "  ✓ Apply complete · 12m 34s"],
    cost: ["$ vertex cost", "", "  EKS cluster   ████████   $219", "  Aurora DB     ██████████ $412", "  ElastiCache   ██████     $156", "  NAT + DNS     ██          $33", "  ─────────────────────────────", "  Total                $847/mo"],
  },
  gcp: {
    plan: ["$ vertex plan", "", "  ▸ Terraform plan…", "  39 resources to add", "  0 to change, 0 to destroy", "", "  Estimated  $612.00/mo"],
    deploy: ["$ vertex deploy", "", "  ✓ google_compute_network.main", "  ✓ google_container_cluster.main", "  ✓ google_sql_database_instance", "  ✓ helm_release.argocd", "  … +29 more", "  ✓ Apply complete · 9m 51s"],
    cost: ["$ vertex cost", "", "  GKE Autopilot ████████   $241", "  Cloud SQL     █████████  $298", "  Memorystore   ████       $128", "  Other         ██          $45", "  ─────────────────────────────", "  Total                $612/mo"],
  },
  azure: {
    plan: ["$ vertex plan", "", "  ▸ Terraform plan…", "  41 resources to add", "  0 to change, 0 to destroy", "", "  Estimated  $408.00/mo"],
    deploy: ["$ vertex deploy", "", "  ✓ azurerm_virtual_network.main", "  ✓ azurerm_kubernetes_cluster", "  ✓ azurerm_postgresql_flexible", "  ✓ helm_release.argocd", "  … +31 more", "  ✓ Apply complete · 11m 08s"],
    cost: ["$ vertex cost", "", "  AKS           ███████    $198", "  Azure PG      ████████   $142", "  Redis         ████        $52", "  Other         █           $16", "  ─────────────────────────────", "  Total                $408/mo"],
  },
};
function Terminal() {
  const [prov, setProv] = React.useState("aws");
  const [tab, setTab] = React.useState("deploy");
  const lines = DEMO[prov][tab];
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", overflow: "hidden", background: "var(--surface)", boxShadow: "var(--shadow-lg)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid var(--border)", background: "var(--surface-muted)" }}>
        <div style={{ display: "flex", gap: 6 }}>{[0, 1, 2].map((i) => <span key={i} style={{ width: 10, height: 10, borderRadius: 999, border: "1px solid var(--border-strong)" }} />)}</div>
        <div style={{ display: "flex", gap: 4 }}>
          {["aws", "gcp", "azure"].map((p) => (
            <button key={p} onClick={() => setProv(p)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 9px", borderRadius: "var(--radius-sm)", border: "1px solid " + (prov === p ? "var(--border-strong)" : "transparent"), background: prov === p ? "var(--surface)" : "transparent", cursor: "pointer", fontSize: 11, color: "var(--text-secondary)", ...wmono }}>
              <img src={`../../assets/providers/${p}.png`} width={13} height={13} style={{ objectFit: "contain" }} />{p.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-faint)" }}>
        <WTabs variant="pill" tabs={[{ id: "plan", label: "Plan" }, { id: "deploy", label: "Deploy" }, { id: "cost", label: "Cost" }]} value={tab} onValueChange={setTab} />
      </div>
      <pre style={{ margin: 0, padding: "18px 20px", ...wmono, fontSize: 13, lineHeight: 1.75, color: "var(--text-secondary)", minHeight: 220, whiteSpace: "pre-wrap" }}>
        {lines.map((l, i) => {
          const strong = l.startsWith("  ✓") || l.includes("Total") || l.includes("complete");
          const dim = l.startsWith("$") || l.startsWith("  ▸");
          return <div key={i} style={{ color: strong ? "var(--text-primary)" : dim ? "var(--text-tertiary)" : "var(--text-secondary)" }}>{l || " "}</div>;
        })}
        <span style={{ display: "inline-block", width: 8, height: 15, background: "var(--text-primary)", verticalAlign: "middle", animation: "vertex-blink 1.4s linear infinite" }} />
      </pre>
    </div>
  );
}

/* ---- Hero ---- */
function Hero() {
  const [copied, setCopied] = React.useState(false);
  const stats = [["3", "Cloud providers"], ["11", "Config sections"], ["16", "CLI commands"], ["0", "Stored credentials"]];
  return (
    <section style={{ position: "relative", paddingTop: 96, paddingBottom: 64 }}>
      <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(var(--border-faint) 1px,transparent 1px),linear-gradient(90deg,var(--border-faint) 1px,transparent 1px)", backgroundSize: "44px 44px", maskImage: "radial-gradient(ellipse 70% 60% at 50% 0%, #000 40%, transparent 75%)", WebkitMaskImage: "radial-gradient(ellipse 70% 60% at 50% 0%, #000 40%, transparent 75%)", pointerEvents: "none" }} />
      <Wrap style={{ position: "relative", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <WBadge variant="outline" mono style={{ marginBottom: 24, padding: "5px 12px", borderRadius: 999 }}>Open-source infrastructure platform</WBadge>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 60, fontWeight: 600, letterSpacing: "-0.04em", lineHeight: 1.04, margin: 0, maxWidth: 760, color: "var(--text-primary)" }}>
          The infrastructure layer<br /><span style={{ color: "var(--text-tertiary)" }}>for cloud-native teams</span>
        </h1>
        <p style={{ fontSize: 19, color: "var(--text-secondary)", maxWidth: 560, margin: "22px 0 32px", lineHeight: 1.5 }}>
          Configure multi-cloud Kubernetes visually. Deploy from the terminal. Zero credentials stored.
        </p>
        <div onClick={() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }} style={{ display: "inline-flex", alignItems: "center", gap: 14, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "10px 16px", marginBottom: 44, cursor: "pointer", background: "var(--surface)" }}>
          <code style={{ ...wmono, fontSize: 14, color: "var(--text-primary)" }}><span style={{ color: "var(--text-tertiary)" }}>$ </span>brew install vertex</code>
          <span style={{ ...ebw, fontSize: 10 }}>{copied ? "Copied" : "Copy"}</span>
        </div>
        <div style={{ width: "100%", maxWidth: 760 }}><Terminal /></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 24, width: "100%", maxWidth: 680, marginTop: 56 }}>
          {stats.map(([v, l]) => (
            <div key={l}><p style={{ fontFamily: "var(--font-display)", fontSize: 34, fontWeight: 600, letterSpacing: "-0.03em", margin: 0, color: "var(--text-primary)" }}>{v}</p><p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "2px 0 0" }}>{l}</p></div>
          ))}
        </div>
      </Wrap>
    </section>
  );
}

/* ---- Features ---- */
function Features() {
  const bullets = [
    ["Network", "Visual configuration", "Eleven guided sections with real-time cost estimation — network, cluster, databases, caches, DNS, secrets, and more."],
    ["Shield", "Zero-credential security", "Cross-account IAM roles, Workload Identity Federation, federated identity. No static keys are ever stored."],
    ["GitBranch", "GitOps by default", "ArgoCD bootstrapped on every cluster. Git is the audit trail. Plan, review, apply — for every change."],
  ];
  const Bicon = { Network: <path d="M9 3h6v4H9zM3 17h6v4H3zm12 0h6v4h-6zM12 7v4m0 0H6v6m6-6h6v6" />, Shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />, GitBranch: <g><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></g> };
  return (
    <section style={{ padding: "72px 0", borderTop: "1px solid var(--border)" }}>
      <Wrap>
        <p style={{ ...ebw, marginBottom: 14 }}>Why Alethia</p>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 34, fontWeight: 600, letterSpacing: "-0.03em", margin: "0 0 12px", maxWidth: 560, color: "var(--text-primary)" }}>Everything you need to ship infrastructure</h2>
        <p style={{ fontSize: 15, color: "var(--text-tertiary)", maxWidth: 520, margin: "0 0 44px", lineHeight: 1.6 }}>A visual configuration form and a CLI that share the same state. Design in the browser, execute from the terminal, reconcile with GitOps.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 22 }}>
          {bullets.map(([ic, title, desc]) => (
            <div key={title}>
              <span style={{ display: "grid", placeItems: "center", width: 38, height: 38, borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--surface-muted)", color: "var(--text-primary)", marginBottom: 16 }}>
                <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">{Bicon[ic]}</svg>
              </span>
              <h3 style={{ fontSize: 15.5, fontWeight: 600, fontFamily: "var(--font-display)", margin: "0 0 7px", color: "var(--text-primary)" }}>{title}</h3>
              <p style={{ fontSize: 13.5, color: "var(--text-tertiary)", lineHeight: 1.6, margin: 0 }}>{desc}</p>
            </div>
          ))}
        </div>
      </Wrap>
    </section>
  );
}

/* ---- Ecosystem / modules ---- */
function Ecosystem() {
  const mods = [["Alethia", "Web control plane", "Visual infrastructure configuration, job dashboard, real-time logs, cost estimation."], ["vertex-cli", "CLI + worker", "An interactive terminal wizard for plan, deploy, and teardown across clouds."]];
  return (
    <section style={{ padding: "0 0 80px" }}>
      <Wrap>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {mods.map(([t, sub, d]) => (
            <WCard key={t} interactive>
              <WCB style={{ display: "flex", gap: 14 }}>
                <span style={{ display: "grid", placeItems: "center", width: 40, height: 40, borderRadius: "var(--radius-md)", background: "var(--surface-muted)", color: "var(--text-primary)", flexShrink: 0 }}>
                  {t === "Alethia" ? <WMark size={20} /> : <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="m4 17 6-6-6-6M12 19h8" /></svg>}
                </span>
                <div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}><h3 style={{ fontSize: 15, fontWeight: 600, fontFamily: "var(--font-display)", margin: 0, color: "var(--text-primary)" }}>{t}</h3><span style={{ fontSize: 12, color: "var(--text-tertiary)", ...wmono }}>{sub}</span></div>
                  <p style={{ fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.55, margin: "6px 0 0" }}>{d}</p>
                </div>
                <span style={{ marginLeft: "auto", color: "var(--text-tertiary)" }}><Arrow /></span>
              </WCB>
            </WCard>
          ))}
        </div>
      </Wrap>
    </section>
  );
}

/* ---- Footer ---- */
function Footer() {
  const cols = [["Product", ["Features", "CLI", "Dashboard", "Ecosystem"]], ["Developers", ["Documentation", "GitHub", "CLI reference"]], ["Resources", ["Architecture", "User flows", "Changelog"]], ["Company", ["Alethia", "Open source", "Contributing"]]];
  return (
    <footer style={{ borderTop: "1px solid var(--border)", padding: "56px 0 32px" }}>
      <Wrap>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr repeat(4,1fr)", gap: 28, marginBottom: 44 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 9, color: "var(--text-primary)", marginBottom: 14 }}><WMark size={22} /><span style={{ fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 600 }}>Alethia</span></div>
            <p style={{ fontSize: 12.5, color: "var(--text-tertiary)", lineHeight: 1.6, maxWidth: 220, margin: 0 }}>Configure multi-cloud infrastructure in the browser. Deploy from the terminal.</p>
          </div>
          {cols.map(([title, links]) => (
            <div key={title}>
              <p style={{ ...ebw, fontSize: 10, marginBottom: 14 }}>{title}</p>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 9 }}>
                {links.map((l) => <li key={l}><a href="#" style={{ fontSize: 13, color: "var(--text-tertiary)" }}>{l}</a></li>)}
              </ul>
            </div>
          ))}
        </div>
        <WSep />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 22 }}>
          <p style={{ ...ebw, fontSize: 10, margin: 0 }}>© 2026 Alethia · Alethia Systems</p>
          <p style={{ ...ebw, fontSize: 10, margin: 0 }}>Built on the ADP control plane · Open source</p>
        </div>
      </Wrap>
    </footer>
  );
}

function Site() {
  return <div><Header /><Hero /><Features /><Ecosystem /><Footer /></div>;
}
window.VxSite = Site;
