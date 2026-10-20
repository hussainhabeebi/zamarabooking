// Zamra Travels brand palette
// Applied as CSS custom properties — override per-tenant via server-side injection
export const BRAND = {
  navy:   "#0D4B96",
  blue:   "#1E88D9",
  sky:    "#66B8E8",
  dark:   "#1A1A1A",
  white:  "#FFFFFF",
} as const;

export const DEFAULT_THEME = {
  primaryColor:   BRAND.navy,
  secondaryColor: BRAND.blue,
  accentColor:    BRAND.sky,
  fontFamily:     "Inter",
  borderRadius:   "8px",
} as const;

// Generates inline CSS for tenant-specific theme injection (used in layout.tsx)
export function generateThemeCSS(config: {
  primaryColor:   string;
  secondaryColor: string;
  accentColor:    string;
  fontFamily:     string;
}): string {
  return `
    :root {
      --color-primary:   ${config.primaryColor};
      --color-secondary: ${config.secondaryColor};
      --color-accent:    ${config.accentColor};
      --font-body:       ${config.fontFamily}, system-ui, sans-serif;
      --border-radius:   8px;
    }
  `.trim();
}
