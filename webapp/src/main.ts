// SPDX-License-Identifier: Apache-2.0
// VeilID demo UI — wires the tabbed role panels to the DemoEngine (the real
// compiled contract, simulator mode). Secret keys are never rendered.
import { DemoEngine, type ClaimRecord, type StepResult } from "./demo.js";

const engine = new DemoEngine();
let running = false;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

// ---------- transcript ----------
function log(message: string, kind: "ok" | "err" | "" = ""): void {
  const li = document.createElement("li");
  if (kind) li.className = kind;
  li.innerHTML = `<b>${now()}</b> — ${message}`;
  $("transcript").prepend(li);
}

// ---------- ledger panel ----------
function renderLedger(): void {
  const s = engine.snapshot();
  const dl = $("ledger");
  if (!s.hasPass) {
    dl.innerHTML = `<dt>status</dt><dd>No pass yet — create one in the Issuer tab.</dd>`;
    return;
  }
  const list = (items: string[]) =>
    items.length ? items.map((x) => `<code>${x}</code>`).join("<br>") : "<em>none</em>";
  dl.innerHTML = `
    <dt>pass</dt><dd>${s.passName}</dd>
    <dt>pass id</dt><dd>${s.passId}</dd>
    <dt>phase</dt><dd>${s.phase}</dd>
    <dt>Merkle root</dt><dd>${s.merkleRoot}</dd>
    <dt>members</dt><dd>${s.memberCount}</dd>
    <dt>eligible proofs</dt><dd>${s.eligibleProofs}</dd>
    <dt>claims</dt><dd>${s.claimCount}</dd>
    <dt>revoked</dt><dd>${s.revokedCount}</dd>
    <dt>commitments</dt><dd>${list(s.commitments)}</dd>
    <dt>nullifiers</dt><dd>${list(s.nullifiers)}</dd>`;
}

// ---------- steps + buttons ----------
function refresh(): void {
  const st = engine.status();
  renderLedger();
  // stepper
  const steps = document.querySelectorAll<HTMLElement>("#steps li");
  const order: Array<[string, boolean, boolean]> = [
    ["issuer", st.stage !== "fresh", st.stage === "claiming" || st.stage === "closed"],
    ["alice", st.aliceProved, st.aliceClaimed],
    ["bob", st.bobProveTried, st.bobClaimTried],
    ["auditor", st.disclosed, false],
  ];
  steps.forEach((li) => {
    const [key, active, done] = order.find(([k]) => k === li.dataset.step) ?? ["", false, false];
    void key;
    li.classList.toggle("active", active && !done);
    li.classList.toggle("done", done);
  });
  // issuer buttons
  ($("btn-create") as HTMLButtonElement).disabled = running || st.stage !== "fresh";
  ($("btn-register") as HTMLButtonElement).disabled = running || st.stage !== "created";
  ($("btn-open") as HTMLButtonElement).disabled = running || st.stage !== "registered";
  ($("btn-close") as HTMLButtonElement).disabled = running || st.stage !== "claiming";
  // alice / bob buttons
  const claiming = st.stage === "claiming";
  ($("btn-alice-prove") as HTMLButtonElement).disabled = running || !claiming;
  ($("btn-alice-claim") as HTMLButtonElement).disabled = running || !claiming || st.aliceClaimed;
  ($("btn-alice-claim-again") as HTMLButtonElement).disabled = running || !claiming || !st.aliceClaimed;
  ($("btn-bob-prove") as HTMLButtonElement).disabled = running || !claiming;
  ($("btn-bob-claim") as HTMLButtonElement).disabled = running || !claiming;
  // auditor
  ($("btn-disclose") as HTMLButtonElement).disabled = running || !st.aliceClaimed || st.disclosed;
  ($("btn-verify") as HTMLButtonElement).disabled = running || !st.disclosed;
  ($("btn-tamper") as HTMLButtonElement).disabled = running || !st.disclosed;
  ($("run-all") as HTMLButtonElement).disabled = running;
  ($("reset") as HTMLButtonElement).disabled = running;
}

// ---------- result rendering ----------
function showResult(elId: string, r: StepResult): void {
  const el = $(elId);
  el.className = `result ${r.ok ? "ok" : "err"}`;
  el.innerHTML = `<strong>${r.title}</strong>\n${r.detail}` +
    (r.publicEffect ? `<span class="pub">${r.publicEffect}</span>` : "") +
    (r.error ? `<span class="errstr">contract: ${r.error}</span>` : "");
  log(`<b>${r.title}</b> — ${r.ok ? "accepted" : "rejected"}`, r.ok ? "ok" : "err");
}

// ---------- tabs ----------
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`tab-${tab.dataset.tab}`).classList.add("active");
  });
});
const showTab = (name: string) => {
  document.querySelector<HTMLButtonElement>(`.tab[data-tab="${name}"]`)?.click();
};

// ---------- issuer ----------
$("btn-create").addEventListener("click", async () => {
  const r = await engine.createPass();
  showResult("result-issuer", r);
  if (r.ok) showTab("issuer");
  refresh();
});
$("btn-register").addEventListener("click", async () => {
  const r = await engine.registerMembers();
  showResult("result-issuer", r);
  if (r.ok) {
    // Commitments come from the public ledger snapshot — the UI never touches secret keys.
    const s = engine.snapshot();
    $("member-list").innerHTML =
      `<strong>Registered members</strong> (commitments only — the issuer never saw a wallet):<br>` +
      ["Alice — jstark.ai", "Carol", "Dave"]
        .map((name, i) => `${name} — <code>commitment ${s.commitments[i] ?? "…"}</code>`)
        .join("<br>");
  }
  refresh();
});
$("btn-open").addEventListener("click", async () => {
  const r = await engine.openClaiming();
  showResult("result-issuer", r);
  if (r.ok) showTab("alice");
  refresh();
});
$("btn-close").addEventListener("click", async () => {
  const r = await engine.closePass();
  showResult("result-issuer", r);
  refresh();
});

// ---------- alice ----------
$("btn-alice-prove").addEventListener("click", async () => {
  const r = await engine.proveEligible("alice");
  showResult("result-alice", r);
  refresh();
});
const aliceClaimHandler = async (again: boolean) => {
  const r = await engine.claim("alice");
  showResult("result-alice", r);
  const rec = engine.getAliceClaim();
  if (r.ok && rec) {
    const box = $("alice-receipt");
    box.hidden = false;
    box.innerHTML =
      `<strong>Claim receipt — keep this private until you choose to disclose it.</strong><br>` +
      `nullifier: <code>${rec.nullifier}</code><br>` +
      `audit salt: <code>${rec.salt.slice(0, 16)}… (full salt only in this panel)</code><br>` +
      `Alice can hand the nullifier + salt to an auditor — see the Auditor tab.`;
    void again;
  }
  refresh();
};
$("btn-alice-claim").addEventListener("click", () => aliceClaimHandler(false));
$("btn-alice-claim-again").addEventListener("click", () => aliceClaimHandler(true));

// ---------- bob ----------
$("btn-bob-prove").addEventListener("click", async () => {
  const r = await engine.proveEligible("bob");
  showResult("result-bob", r);
  refresh();
});
$("btn-bob-claim").addEventListener("click", async () => {
  const r = await engine.claim("bob");
  showResult("result-bob", r);
  refresh();
});

// ---------- auditor ----------
let disclosedSalt = "";
$("btn-disclose").addEventListener("click", () => {
  const rec: ClaimRecord | null = engine.discloseToAuditor();
  if (!rec) return;
  disclosedSalt = rec.salt;
  $("audit-form").hidden = false;
  ($("audit-fp") as HTMLInputElement).value = rec.fingerprint;
  ($("audit-nul") as HTMLInputElement).value = rec.nullifier;
  ($("audit-salt") as HTMLInputElement).value = rec.salt;
  ($("result-auditor") as HTMLElement).className = "result ok";
  $("result-auditor").innerHTML =
    `<strong>Disclosure received (off-chain).</strong>\nAlice handed the auditor exactly three values: a fingerprint, a nullifier and a salt. No wallet, no secret key, no commitment. Press Verify.`;
  log("<b>Alice disclosed one claim</b> to the auditor (off-chain)", "ok");
  refresh();
});
$("btn-verify").addEventListener("click", () => {
  const fp = ($("audit-fp") as HTMLInputElement).value;
  const nul = ($("audit-nul") as HTMLInputElement).value;
  const salt = ($("audit-salt") as HTMLInputElement).value;
  const v = engine.verifyAudit(nul, salt, fp);
  const el = $("result-auditor");
  el.className = `result ${v.match ? "ok" : "err"}`;
  el.innerHTML = `<strong>${v.match ? "✓ MATCH" : "✕ NO MATCH"}</strong>\n${v.reason}`;
  log(`Auditor verification: <b>${v.match ? "MATCH" : "NO MATCH"}</b>`, v.match ? "ok" : "err");
});
$("btn-tamper").addEventListener("click", () => {
  const input = $("audit-salt") as HTMLInputElement;
  const s = input.value;
  if (s.length < 2) return;
  const last = s.slice(-1);
  const flipped = last === "0" ? "1" : "0";
  input.value = s.slice(0, -1) + flipped;
  ($("btn-restore-salt") as HTMLButtonElement).disabled = false;
  log("Salt tampered — one hex digit flipped. Press Verify to see it fail.", "err");
});
$("btn-restore-salt").addEventListener("click", () => {
  ($("audit-salt") as HTMLInputElement).value = disclosedSalt;
  ($("btn-restore-salt") as HTMLButtonElement).disabled = true;
  log("Real salt restored.", "ok");
});

// ---------- reset / run all ----------
$("reset").addEventListener("click", () => {
  engine.reset();
  disclosedSalt = "";
  for (const id of ["result-issuer", "result-alice", "result-bob", "result-auditor"]) {
    const el = $(id);
    el.className = "result";
    el.innerHTML = "<em>Reset — start again from the Issuer tab.</em>";
  }
  $("member-list").innerHTML = "";
  $("alice-receipt").hidden = true;
  $("audit-form").hidden = true;
  ($("btn-restore-salt") as HTMLButtonElement).disabled = true;
  $("run-status").textContent = "";
  log("Demo reset — fresh random keys generated.");
  showTab("issuer");
  refresh();
});

$("run-all").addEventListener("click", async () => {
  if (running) return;
  running = true;
  $("run-status").textContent = "Running the full demo…";
  refresh();
  const step = async (fn: () => void, ms = 750) => {
    fn();
    await sleep(ms);
  };
  try {
    if (engine.status().stage === "fresh") {
      showTab("issuer");
      await step(() => $("btn-create").click());
      await step(() => $("btn-register").click());
      await step(() => $("btn-open").click());
    }
    showTab("alice");
    await step(() => $("btn-alice-prove").click());
    await step(() => $("btn-alice-claim").click());
    await step(() => $("btn-alice-claim-again").click());
    showTab("bob");
    await step(() => $("btn-bob-prove").click());
    await step(() => $("btn-bob-claim").click());
    showTab("auditor");
    await step(() => $("btn-disclose").click());
    await step(() => $("btn-verify").click());
    await step(() => $("btn-tamper").click());
    await step(() => $("btn-verify").click());
    await step(() => $("btn-restore-salt").click());
    await step(() => $("btn-verify").click(), 400);
    $("run-status").textContent = "Demo complete — Alice proved, claimed once, Bob was rejected twice, and the auditor verified the claim (and caught the tampered salt).";
    log("<b>Full demo complete.</b>", "ok");
  } finally {
    running = false;
    refresh();
  }
});

// ---------- init ----------
refresh();
log("VeilID demo loaded — simulator mode, fresh random keys. Press “Run full demo”.");
