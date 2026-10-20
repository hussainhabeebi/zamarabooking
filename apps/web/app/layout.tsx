import type { Metadata, Viewport } from "next";
import "./globals.css";
import SiteNav from "./components/SiteNav";
import SiteFooter from "./components/SiteFooter";

export const metadata: Metadata = {
  title: "FlyPoomas",
  description: "Book flights at best prices — India, Gulf & beyond",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "FlyPoomas" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#E31E24",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://images.unsplash.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://images.unsplash.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <header className="site-header">
          <a href="/" className="site-logo-link">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" height={34} className="site-logo" />
            <span className="site-brand-name">FlyPoomas</span>
          </a>
          <SiteNav />
        </header>
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
