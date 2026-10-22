import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = new URL("../dist/", import.meta.url);
// Compile only the EXISTING Akbar implementation, never duplicate its logic.
execFileSync(
  process.execPath,
  [
    root + "packages/suppliers/node_modules/typescript/bin/tsc",
    root + "packages/suppliers/src/akbar/adapter.ts",
    root + "packages/suppliers/src/akbar/gateway-auth.ts",
    "--rootDir",
    root + "packages/suppliers/src",
    "--outDir",
    fileURLToPath(out),
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--strict",
    "--skipLibCheck",
  ],
  { stdio: "inherit" },
);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("package.json", out), ' {"type":"module"}\n');
