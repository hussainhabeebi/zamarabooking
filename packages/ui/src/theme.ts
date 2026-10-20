// POOMAS Traveldays brand palette
// Applied as CSS custom properties — override per-tenant via server-side injection
export const BRAND = {
  red:    "#E31E24",
  orange: "#F7941D",
  yellow: "#F5C518",
  dark:   "#1A1A1A",
  white:  "#FFFFFF",
} as const;

export const DEFAULT_THEME = {
  primaryColor:   BRAND.red,
  secondaryColor: BRAND.orange,
  accentColor:    BRAND.yellow,
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
