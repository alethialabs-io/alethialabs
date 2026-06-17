/* Alethia platform UI kit — interactive control-plane recreation.
   Composes the Alethia Labs design-system primitives (window.VertexDesignSystem_8c015f). */
const VX = window.VertexDesignSystem_8c015f;
const { Button, Badge, StatusBadge, Card, CardHeader, CardTitle, CardDescription, CardBody, CardFooter, Input, Field, Label, Hint, Select, Switch, Checkbox, Radio, Tabs, Avatar, Separator, Alert, Spinner } = VX;
const Ic = window.VxIcons;

const Mark = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ display: "block", flexShrink: 0 }}>
    <path d="M11 6 H6.5 V26 H11" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M21 6 H25.5 V26 H21" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="16" cy="16" r="2.9" fill="currentColor" />
  </svg>
);
const Provider = ({ id, size = 18 }) => (
  <img src={`../../assets/providers/${id}.png`} alt={id} width={size} height={size} style={{ objectFit: "contain", display: "block" }} />
);
const eyebrow = { fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--text-tertiary)" };
const mono = { fontFamily: "var(--font-mono)" };

/* ---------------- Sign in ---------------- */
function SignIn({ onAuth }) {
  return (
    <div style={{ minHeight: "100%", display: "grid", placeItems: "center", padding: "40px 20px", background: "var(--canvas)" }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18, marginBottom: 28, color: "var(--text-primary)" }}>
          <Mark size={40} />
          <div style={{ textAlign: "center" }}>
            <h1 style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>Sign in to Alethia</h1>
            <p style={{ color: "var(--text-tertiary)", fontSize: 14, margin: "6px 0 0" }}>Configure infrastructure. Deploy from the terminal.</p>
          </div>
        </div>
        <Card>
          <CardBody style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[["github", "GitHub"], ["gitlab", "GitLab"], ["bitbucket", "Bitbucket"]].map(([id, name]) => (
              <Button key={id} variant="outline" onClick={onAuth} style={{ width: "100%", height: 40, fontWeight: 400 }}>
                <img src={`../../assets/integrations/${id}.png`} width={16} height={16} alt="" style={{ objectFit: "contain" }} />
                Continue with {name}
              </Button>
            ))}
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 0" }}>
              <Separator /><span style={{ ...eyebrow }}>or</span><Separator />
            </div>
            <Field>
              <Input placeholder="name@example.com" defaultValue="" />
            </Field>
            <Button variant="primary" onClick={onAuth} style={{ width: "100%", height: 40 }}><Ic.Mail size={16} />Send magic link</Button>
          </CardBody>
        </Card>
        <p style={{ ...eyebrow, textAlign: "center", marginTop: 20 }}>Zero credentials stored · SOC-2 aligned</p>
      </div>
    </div>
  );
}

/* ---------------- Shell ---------------- */
const NAV = [
  ["overview", "Overview", "Dashboard"],
  ["plant", "Plant a Vine", "Plus"],
  ["clusters", "Clusters", "Server"],
  ["jobs", "Jobs", "Jobs"],
  ["integrations", "Integrations", "Blocks"],
  ["tendrils", "Tendrils", "Workflow"],
];
const TITLES = { overview: "Overview", plant: "Plant a Vine", clusters: "Clusters", jobs: "Jobs", integrations: "Integrations", tendrils: "Tendrils" };

function Sidebar({ active, setActive, onLogout }) {
  return (
    <aside style={{ width: "var(--sidebar-w)", flexShrink: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--border)", background: "color-mix(in oklch, var(--canvas) 60%, var(--surface))" }}>
      <div style={{ height: "var(--header-h)", display: "flex", alignItems: "center", gap: 9, padding: "0 18px", borderBottom: "1px solid var(--border)", color: "var(--text-primary)" }}>
        <Mark size={22} />
        <span style={{ fontFamily: "var(--font-display)", fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em" }}>Alethia</span>
        <Badge variant="outline" mono style={{ marginLeft: "auto", fontSize: 9 }}>v1.4</Badge>
      </div>
      <nav style={{ flex: 1, padding: 12, display: "flex", flexDirection: "column", gap: 2, overflowY: "auto" }}>
        {NAV.map(([id, label, icon]) => {
          const Icon = Ic[icon];
          const on = active === id;
          return (
            <button key={id} onClick={() => setActive(id)} style={{
              display: "flex", alignItems: "center", gap: 10, height: 34, padding: "0 10px", borderRadius: "var(--radius-sm)",
              border: "none", cursor: "pointer", textAlign: "left", width: "100%",
              fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500,
              background: on ? "var(--surface-muted)" : "transparent",
              color: on ? "var(--text-primary)" : "var(--text-tertiary)",
              transition: "background var(--duration-fast), color var(--duration-fast)",
            }}>
              <Icon size={16} />{label}
            </button>
          );
        })}
        <p style={{ ...eyebrow, margin: "18px 10px 8px" }}>Vineyards</p>
        {[["production", "active"], ["staging", "active"], ["sandbox", "idle"]].map(([v, s]) => (
          <button key={v} style={{ display: "flex", alignItems: "center", gap: 10, height: 30, padding: "0 10px", borderRadius: "var(--radius-sm)", border: "none", background: "transparent", cursor: "pointer", width: "100%", color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
            <StatusBadge status={s} showLabel={false} />{v}
          </button>
        ))}
      </nav>
      <div style={{ padding: 12, borderTop: "1px solid var(--border)" }}>
        <button onClick={onLogout} style={{ display: "flex", alignItems: "center", gap: 10, padding: 8, borderRadius: "var(--radius-sm)", width: "100%", border: "1px solid transparent", background: "transparent", cursor: "pointer", textAlign: "left" }} title="Sign out">
          <Avatar initials="BB" size={30} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>Borislav B.</p>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-tertiary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>bobi@alethia.dev</p>
          </div>
          <span style={{ color: "var(--text-tertiary)" }}><Ic.Logout size={15} /></span>
        </button>
      </div>
    </aside>
  );
}

function TopBar({ active }) {
  return (
    <header style={{ height: "var(--header-h)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px", borderBottom: "1px solid var(--border)", background: "color-mix(in oklch, var(--canvas) 80%, transparent)", backdropFilter: "blur(8px)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, ...mono, fontSize: 12, color: "var(--text-tertiary)" }}>
        <span>alethia</span><Ic.ChevronRight size={13} /><span style={{ color: "var(--text-primary)" }}>{TITLES[active]}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Button variant="ghost" size="sm" icon aria-label="Search"><Ic.Search size={16} /></Button>
        <div style={{ position: "relative" }}>
          <Button variant="ghost" size="sm" icon aria-label="Notifications"><Ic.Bell size={16} /></Button>
          <span style={{ position: "absolute", top: 6, right: 6, width: 6, height: 6, borderRadius: 999, background: "var(--text-primary)" }} />
        </div>
        <Separator orientation="vertical" style={{ height: 20, margin: "0 4px" }} />
        <Avatar initials="BB" size={28} />
      </div>
    </header>
  );
}

window.VxApp = { SignIn, Sidebar, TopBar, Mark, Provider, eyebrow, mono, Ic, VX };
