// Downloads the Shopify Admin GraphQL schema (introspection JSON) used by the
// schema validation test. The schema ships inside Shopify's @shopify/dev-mcp
// package, so no store credentials are needed.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const version = process.argv[2] ?? "2026-10";
const dir = path.resolve(".cache/schema");
fs.mkdirSync(dir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(dir, "pkg-"));
execSync("npm pack @shopify/dev-mcp --silent", { cwd: tmp, stdio: "inherit" });
const tgz = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
execSync(`tar xzf ${tgz} package/dist/data/admin_${version}.json.gz`, { cwd: tmp });
fs.copyFileSync(path.join(tmp, `package/dist/data/admin_${version}.json.gz`), path.join(dir, `admin_${version}.json.gz`));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Saved .cache/schema/admin_${version}.json.gz`);
