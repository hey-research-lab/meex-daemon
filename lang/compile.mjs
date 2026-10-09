// Skill compiler prototype: agentfile `skill` blocks (HCL) → canonical JSON → x402 v2 PaymentRequirements +
// Bazaar discovery metadata, with the static checks a self-modifying daemon must pass before a skill can go live.
//
// Steps come from a CLOSED set (x402 · fetch · model · mob · pick · message). There is no code step: a daemon rewriting itself
// can only rearrange vetted blocks, and every block declares its worst-case cost, so `price >= max cost` is checked
// at plan time instead of discovered at a loss.
import { parse } from "@cdktf/hcl2json";

import { compileDoc } from "./check.mjs";
export * from "./check.mjs";

// 🔴 the HCL parser returns a block's steps in ALPHABETICAL order (Go maps), not as written — order comes from the source
export function stepOrder(src, kind, name) {
  // start AT the keyword: a leading `\s*` can swallow a blank line, and the next-block search would then stop at once
  const m = new RegExp(`(^|\\n)[ \\t]*(${kind}\\s+"${name}"\\s*\\{)`).exec(src);
  if (!m) return null;
  const rest = src.slice(m.index + m[0].length - m[2].length);
  const end = rest.search(/\n\s*(skill|strategy)\s+"/);
  return [...(end < 0 ? rest : rest.slice(0, end)).matchAll(/\bstep\s+"([\w-]+)"/g)].map((m) => m[1]);
}

/** HCL → the parsed doc with every block's steps in SOURCE order → the checks. */
export async function compileFile(src) {
  const doc = await parse("agentfile.hcl", src);
  for (const kind of ["skill", "strategy"]) for (const [name, raw] of Object.entries(doc[kind] ?? {})) {
    const b = Array.isArray(raw) ? raw[0] : raw;
    const order = stepOrder(src, kind, name);
    if (b.step && order) b.step = Object.fromEntries(order.filter((id) => id in b.step).map((id) => [id, b.step[id]]));
  }
  return { ...compileDoc(doc), doc };
}
