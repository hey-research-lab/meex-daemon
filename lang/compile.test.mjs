import { test } from "node:test";
import assert from "node:assert/strict";
import { compileFile, requirements, RHC, stepOrder } from "./compile.mjs";

const good = `
skill "appraise_slab" {
  description = "Prices a graded Pokémon slab by cert number: sold prices raw and by grade, each with its source."
  price   = "0.03"
  timeout = "30s"
  input { cert = "string" }
  step "appraise" {
    x402  = "https://www.retcg.xyz/api/appraise/pokemon"
    max   = "0.02"
    query = { cert = "\${input.cert}" }
  }
  step "basis" {
    fetch = "https://slabbasis.xyz/v1/cert/\${input.cert}"
  }
  output = "\${steps.appraise.body}"
}`;

test("a valid skill compiles to x402 v2 requirements on RHC, paid to the daemon's TBA", async () => {
  const { skills, hash } = await compileFile(good);
  const s = skills[0];
  assert.ok(s.ok, s.errors.join("; "));
  assert.equal(s.maxCost, 0.02);
  const r = requirements({ ...s, name: "appraise_slab" }, { daemonId: 212, tba: "0x00000000000000000000000000000000000000aa" });
  assert.equal(r.network, "eip155:4663");
  assert.equal(r.asset, RHC.asset);
  assert.equal(r.amount, "30000"); // 0.03 USDG, 6 decimals
  assert.equal(r.payTo, "0x00000000000000000000000000000000000000aa");
  assert.equal(r.resource.url, "https://obol.sh/d/212/appraise_slab");
  assert.deepEqual(r.discovery.inputSchema.required, ["cert"]);
  assert.match(hash, /^[0-9a-f]{12}$/);
});

const bad = (body) => compileFile(`skill "x" {\n description = "d"\n price = "0.01"\n input { cert = "string" }\n${body}\n output = "\${steps.a.body}"\n}`).then((r) => r.skills[0]);

test("refuses a price under the worst-case cost", async () => {
  const s = await bad(`step "a" {\n x402 = "https://www.retcg.xyz/api/appraise/pokemon"\n max = "0.02"\n }`);
  assert.ok(!s.ok); assert.match(s.errors.join(), /below the worst-case cost/);
});
test("accepts a price equal to the worst-case cost, whatever the float sum", async () => {
  const { skills } = await compileFile(`skill "x" {\n description = "d"\n price = "0.3"\n step "a" {\n x402 = "https://www.retcg.xyz/api/a"\n max = "0.1"\n }\n step "b" {\n x402 = "https://www.retcg.xyz/api/b"\n max = "0.2"\n }\n output = "\${steps.b.body}"\n}`);
  assert.ok(skills[0].ok, skills[0].errors.join("; "));
  assert.equal(skills[0].maxCost, 0.3);
});
test("refuses URLs off the allowlist", async () => {
  const s = await bad(`step "a" { fetch = "https://evil.example/x" }`);
  assert.ok(!s.ok); assert.match(s.errors.join(), /allowlist/);
});
test("refuses expressions (function calls), allows plain references", async () => {
  const s = await bad(`step "a" { fetch = "https://mob.markets/api/board?x=\${upper(input.cert)}" }`);
  assert.ok(!s.ok); assert.match(s.errors.join(), /only .* references/);
});
test("refuses references to unknown inputs and later steps", async () => {
  const s = await bad(`step "a" { fetch = "https://mob.markets/api/\${input.nope}" }`);
  assert.ok(!s.ok); assert.match(s.errors.join(), /unknown input "nope"/);
  const t = await bad(`step "a" { fetch = "https://mob.markets/api/\${steps.b.body}" }\n step "b" { fetch = "https://mob.markets/api/board" }`);
  assert.ok(!t.ok); assert.match(t.errors.join(), /isn't an earlier step/);
});
test("refuses a step that is not exactly one known kind (no code steps)", async () => {
  const s = await bad(`step "a" { run = "rm -rf /" }`);
  assert.ok(!s.ok); assert.match(s.errors.join(), /exactly one of/);
});
test("refuses an x402/model step without a max", async () => {
  const s = await bad(`step "a" { x402 = "https://www.retcg.xyz/api/appraise/pokemon" }`);
  assert.ok(!s.ok); assert.match(s.errors.join(), /bad amount/);
});

test("the version hash covers nested content (a changed URL changes it)", async () => {
  const a = await compileFile(good);
  const b = await compileFile(good.replace("https://www.retcg.xyz/api/appraise/pokemon", "https://www.retcg.xyz/api/appraise/magic"));
  assert.notEqual(a.hash, b.hash);
});

test("message step: a sibling number, a body, a known kind", async () => {
  const ok = await compileFile(`strategy "tell" {
  every = "1h"
  input { }
  step "t" {
    message = 1
    body = "hello"
  }
}`);
  assert.equal(ok.strategies[0].ok, true, ok.strategies[0].errors.join("; "));
  for (const [step, re] of [
    [`message = 0\n    body = "x"`, /daemon number/],
    [`message = 20000\n    body = "x"`, /daemon number/],
    [`message = 1`, /body required/],
    [`message = 1\n    body = "x"\n    kind = "order"`, /note or propose/],
  ]) {
    const r = await compileFile(`strategy "tell" {\n  every = "1h"\n  input { }\n  step "t" {\n    ${step}\n  }\n}`);
    assert.equal(r.strategies[0].ok, false, step);
    assert.match(r.strategies[0].errors.join("; "), re, step);
  }
});

const strat = (steps, top = "") => `${top}\nstrategy "s" {\n  every = "1h"\n  input { }\n${steps}\n}`;
test("model step: known model, a prompt, a max that covers the worst case, and a think budget", async () => {
  const good = `  step "r" {\n    inbox = "new"\n    skip_if_empty = true\n  }\n  step "t" {\n    model = "qwen"\n    prompt = "Reply to: \${steps.r.body}"\n    max = "0.001"\n  }`;
  const ok = await compileFile(strat(good, 'think_budget = "0.05"'));
  assert.equal(ok.strategies[0].ok, true, ok.strategies[0].errors.join("; "));
  assert.equal(ok.thinkBudget, 0.05);
  for (const [src, re] of [
    [strat(good), /needs think_budget/],
    [strat(good, 'think_budget = "50"'), /≤ 5/],
    [strat(good.replace('"qwen"', '"gpt9"'), 'think_budget = "0.05"'), /model must be/],
    [strat(good.replace('max = "0.001"', 'max = "0.0001"'), 'think_budget = "0.05"'), /worst-case/],
    [strat(good.replace('    prompt = "Reply to: \${steps.r.body}"\n', ""), 'think_budget = "0.05"'), /prompt required/],
    [strat(good.replace('inbox = "new"', 'inbox = "all"'), 'think_budget = "0.05"'), /inbox must be/],
  ]) {
    const r = await compileFile(src);
    assert.equal(r.strategies[0].ok, false, src);
    assert.match(r.strategies[0].errors.join("; "), re, src);
  }
});
test("a step's output can't steer a URL (injection guard)", async () => {
  const r = await compileFile(strat(`  step "a" {\n    mob = "top_movers"\n  }\n  step "b" {\n    fetch = "https://mob.markets/api/\${steps.a.body}"\n  }`));
  assert.equal(r.strategies[0].ok, false);
  assert.match(r.strategies[0].errors.join("; "), /can't contain a step's output/);
});

test("steps run in the order written, not alphabetical (the HCL parser sorts them)", async () => {
  const r = await compileFile(`skill "x" {\n  description = "d"\n  price = "0.01"\n  input { }\n  step "zeta" {\n    mob = "top_movers"\n  }\n  step "alpha" {\n    pick = "\${steps.zeta.body}"\n  }\n}\nskill "y" {\n  description = "d"\n  price = "0.01"\n  input { }\n  step "b" {\n    mob = "top_movers"\n  }\n  step "a" {\n    mob = "top_movers"\n  }\n}`);
  assert.deepEqual(r.skills[0].steps.map((s) => s.id), ["zeta", "alpha"]);
  assert.equal(r.skills[0].ok, true, r.skills[0].errors.join("; "));
  assert.deepEqual(r.skills[1].steps.map((s) => s.id), ["b", "a"]);
});

test("the version hash covers step order (same steps, other order → other hash)", async () => {
  const mk = (a, b) => `skill "x" {\n  description = "d"\n  price = "0.01"\n  input { }\n  step "${a}" {\n    mob = "top_movers"\n  }\n  step "${b}" {\n    mob = "gap:TSLA"\n  }\n}`;
  const one = await compileFile(mk("p", "q"));
  const two = await compileFile(mk("q", "p").replace('mob = "gap:TSLA"', "MOB").replace('mob = "top_movers"', 'mob = "gap:TSLA"').replace("MOB", 'mob = "top_movers"'));
  assert.notEqual(one.hash, two.hash);
});

test("step order survives a block that follows a blank line with no comment above it", () => {
  const src = 'strategy "a" {\n  every = "1h"\n  step "z" { mob = "top_movers" }\n}\n\nstrategy "b" {\n  every = "1h"\n  step "y" { mob = "top_movers" }\n  step "x" { mob = "top_movers" }\n}\n';
  assert.deepEqual(stepOrder(src, "strategy", "b"), ["y", "x"]);
  assert.deepEqual(stepOrder(src, "strategy", "a"), ["z"]);
  assert.deepEqual(stepOrder('\n\n\nstrategy "c" {\n  step "w" { mob = "top_movers" }\n}', "strategy", "c"), ["w"]);
});
