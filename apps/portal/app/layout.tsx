import type { Metadata, Viewport } from "next";
import "./portal.css";

export const metadata: Metadata = {
  title: "FlyPoomas Agent Portal",
  description: "Book flights, manage your wallet, sub-agents and customers",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "FlyPoomas Agent" },
  icons: { icon: "/logo.png", apple: "/logo.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#111827",
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body>
        {children}
        {/* Installable app (PWA): register the service worker. */}
        <script dangerouslySetInnerHTML={{ __html: `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}` }} />
      </body>
    </html>
  );
}
