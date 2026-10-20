export default function NotFound() {
  return (
    <div style={{ textAlign: "center", padding: "80px 24px" }}>
      <h1 style={{ fontSize: 48, fontWeight: 800, color: "#E31E24" }}>404</h1>
      <p style={{ fontSize: 18, color: "#6b7280", marginTop: 12 }}>Page not found</p>
      <a href="/" style={{ display: "inline-block", marginTop: 24, color: "#E31E24", fontWeight: 600 }}>
        Go home
      </a>
    </div>
  );
}
