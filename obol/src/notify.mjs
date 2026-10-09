// One email to the holder when a daemon drafts a change to itself (milestone 08). Holders are wallets with no email on
// file, so for now every held self-draft goes to HOLDER_EMAIL (the operator, who holds the test daemons). Resend, from
// the verified mail.meex.work domain (secret RESEND_KEY). A failed send never blocks the proposal.
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function draftWaiting(env, { daemon, proposal, reason, plan, gates, evidence }) {
  if (!env.RESEND_KEY || !env.HOLDER_EMAIL) return false;
  const ok = gates?.every((g) => g.ok);
  const lines = [
    `Daemon #${daemon} drafted a change to itself and is waiting for you (proposal #${proposal}).`, "",
    `Its reason: ${reason}`, `Plan: ${(plan ?? []).join("; ")}`,
    `Gates: ${ok ? "all pass" : (gates ?? []).filter((g) => !g.ok).map((g) => `${g.gate} — ${g.detail}`).join("; ")}`,
  ];
  if (evidence?.kind === "schedule replay") {
    const row = (x) => `every ${x.every}: ${x.calls} model calls (${x.modelUSDG} USDG), median wait ${x.medianWaitMin} min, longest ${x.longestWaitMin}`;
    lines.push("", "The last 7 days replayed:", `  now:   ${row(evidence.before)}`, `  draft: ${row(evidence.after)}`);
  }
  lines.push("", "Review and decide on the Mac:", `  node tools/decide.mjs ${daemon} ${proposal}`, `  node tools/decide.mjs ${daemon} ${proposal} approve`, `  node tools/decide.mjs ${daemon} ${proposal} reject "<why>"`,
    "", `It won't draft again until you decide. https://obol.sh/api/daemon/${daemon}/proposals/${proposal}`);
  const text = lines.join("\n");
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${env.RESEND_KEY}`, "content-type": "application/json" }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ from: "Daemon <daemon@mail.meex.work>", to: [env.HOLDER_EMAIL], reply_to: "hello@meex.work", subject: `Daemon #${daemon} drafted a change to itself — review #${proposal}`,
      text, html: `<pre style="font:14px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${esc(text)}</pre>` }) });
  return r.ok;
}
