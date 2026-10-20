import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "POOMAS Admin",
  description: "POOMAS platform super-admin panel",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "POOMAS Admin" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#0f172a",
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <style>{`
          *, *::before, *::after { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: Inter, system-ui, -apple-system, sans-serif;
            background: #0f172a;
            color: white;
            -webkit-font-smoothing: antialiased;
            -webkit-tap-highlight-color: transparent;
          }
          img { max-width: 100%; display: block; }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
