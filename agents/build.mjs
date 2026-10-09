// Compile every agents/<id>.hcl into obol/src/agents.json (each daemon's GENESIS: once its repo has commits, the repo wins) — refusing to build if any skill or strategy fails a check.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { compileFile } from "../lang/compile.mjs";
const out = {};
let bad = 0;
for (const f of readdirSync(new URL(".", import.meta.url)).filter((f) => /^\d+\.hcl$/.test(f))) {
  const id = f.replace(".hcl", "");
  const c = await compileFile(readFileSync(new URL(f, import.meta.url), "utf8"));
  for (const x of [...c.skills, ...c.strategies]) if (!x.ok) { bad++; console.error(`✕ daemon ${id} ${x.name}: ${x.errors.join("; ")}`); }
  out[id] = { version: c.hash, thinkBudget: c.thinkBudget, doc: c.doc, skills: Object.fromEntries(c.skills.map((s) => [s.name, s])), strategies: Object.fromEntries(c.strategies.map((s) => [s.name, s])) };
  console.log(`✓ daemon ${id} @ ${c.hash}: ${c.skills.map((s) => s.name).join(", ") || "no skills"} · ${c.strategies.map((s) => s.name).join(", ") || "no strategies"}`);
}
if (bad) process.exit(1);
writeFileSync(new URL("../obol/src/agents.json", import.meta.url), JSON.stringify(out, null, 1));
