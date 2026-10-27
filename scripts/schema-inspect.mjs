// Prints types/fields from the cached Admin schema (run `npm run schema:fetch` first).
//   node scripts/schema-inspect.mjs Product            -> fields of a type (deprecated ones hidden)
//   node scripts/schema-inspect.mjs Mutation.productSet -> arguments and return type
//   node scripts/schema-inspect.mjs --sdl ProductSetInput -> full SDL incl. deprecated
import fs from "node:fs";
import zlib from "node:zlib";
import { buildClientSchema, printType } from "graphql";

const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(".cache/schema/admin_2026-10.json.gz")).toString("utf8"));
const schema = buildClientSchema(json.data ?? json);
const roots = { Query: "QueryRoot", Mutation: "Mutation" };
let sdl = false;
for (const arg of process.argv.slice(2)) {
  if (arg === "--sdl") { sdl = true; continue; }
  if (arg.includes(".")) {
    const [t, f] = arg.split(".");
    const field = schema.getType(roots[t] ?? t)?.getFields?.()[f];
    if (!field) { console.log(`MISSING ${arg}`); continue; }
    console.log(`${arg}(${field.args.map((a) => `${a.name}: ${a.type}`).join(", ")}): ${field.type}${field.deprecationReason ? `  DEPRECATED: ${field.deprecationReason}` : ""}`);
    continue;
  }
  const type = schema.getType(arg);
  if (!type) { console.log(`MISSING ${arg}`); continue; }
  if (sdl) { console.log(printType(type).replace(/"""[\s\S]*?"""\n/g, "").replace(/\n\s*\n/g, "\n")); continue; }
  if (type.getValues) { console.log(`${arg}: ${type.getValues().map((v) => v.name).join(" ")}`); continue; }
  if (!type.getFields) { console.log(`${arg}: ${type.constructor.name}${type.getTypes ? " = " + type.getTypes().map((t) => t.name).join(" | ") : ""}`); continue; }
  console.log(`${arg}: ` + Object.values(type.getFields()).filter((f) => !f.deprecationReason)
    .map((f) => `${f.name}${f.args?.length ? "(..)" : ""}: ${f.type}`).join(", "));
}
