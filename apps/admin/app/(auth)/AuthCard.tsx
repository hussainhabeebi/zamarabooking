// Shared frame for the admin sign-in pages.
export default function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0f172a", padding: 16 }}>
      <div style={{ background: "#1e293b", borderRadius: 12, padding: "36px 40px", border: "1px solid #334155", width: "100%", maxWidth: 420, color: "#e2e8f0" }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="FlyPoomas" height={36} style={{ display: "inline-block" }} />
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 10 }}>{title}</div>
        </div>
        {children}
      </div>
    </div>
  );
}

export const authInput: React.CSSProperties = {
  padding: "12px 14px", border: "1.5px solid #334155", borderRadius: 8, fontSize: 15,
  width: "100%", boxSizing: "border-box", background: "#0f172a", color: "#e2e8f0",
};
export const authButton = (busy: boolean): React.CSSProperties => ({
  background: "#E31E24", color: "white", border: "none", borderRadius: 8, padding: "13px",
  fontWeight: 700, fontSize: 15, cursor: "pointer", opacity: busy ? 0.7 : 1,
});
export const authNote = (ok: boolean): React.CSSProperties => ({
  background: ok ? "rgba(34,197,94,.12)" : "#450a0a", color: ok ? "#86efac" : "#fca5a5", padding: "10px 14px", borderRadius: 6, marginBottom: 16, fontSize: 14,
});
