import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./site-shell.css";
import SiteNav from "./components/SiteNav";
import SiteFooter from "./components/SiteFooter";

export const metadata: Metadata = {
  title: "ZamraBooking",
  description: "Compare flights and plan your journey — India, the Gulf and beyond",
  manifest: "/manifest.json",
  icons: {
    icon: [{ url: "/favicon.ico", sizes: "any" }, { url: "/icon.png", type: "image/png", sizes: "512x512" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, statusBarStyle: "default", title: "ZamraBooking" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#0D4B96",
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
        <header className="site-header zamra-header">
          <a href="/" className="site-logo-link">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="Zamra Travels" height={34} className="site-logo" />
            <span className="site-brand-name">ZamraBooking</span>
          </a>
          <SiteNav />
        </header>
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
