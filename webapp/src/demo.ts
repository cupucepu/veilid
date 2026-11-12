// SPDX-License-Identifier: Apache-2.0
// VeilID demo engine — drives the real compiled contract (via the simulator
// from ../contract/src/simulator.ts) with synthetic personas. No wallet, no
// network, no real proofs: circuits run against the simulated ledger, exactly
// like the 22 contract tests. Secret keys are generated fresh per run with
// crypto.getRandomValues and are never rendered by the UI.
import { Phase } from "../../contract/src/managed/veilid/contract/index.js";
import { VeilIdSimulator } from "../../contract/src/simulator.js";

export const randomBytes = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
};

export const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const shortHex = (b: Uint8Array): string => {
  const h = hex(b);
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
};

export const hexToBytes = (h: string): Uint8Array | null => {
  const clean = h.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export type PersonaId = "alice" | "carol" | "dave" | "bob";

export const PERSONAS: Record<PersonaId, { name: string; role: string; note: string }> = {
  alice: {
    name: "Alice — jstark.ai",
    role: "Eligible holder",
    note: "Holds a .ai Agent ID. Registered by the issuer.",
  },
  carol: { name: "Carol", role: "Eligible holder", note: "Holds a .ai Agent ID. Registered by the issuer." },
  dave: { name: "Dave", role: "Eligible holder", note: "Holds a .ai Agent ID. Registered by the issuer." },
  bob: {
    name: "Bob",
    role: "Sybil / non-member",
    note: "Holds no Agent ID in this pass. Never registered.",
  },
};

export type Stage = "fresh" | "created" | "registered" | "claiming" | "closed";

export type StepResult = {
  ok: boolean;
  title: string;
  detail: string;
  publicEffect?: string;
  /** Exact error string thrown by the contract/witness, when rejected. */
  error?: string;
};

export type LedgerSnapshot = {
  hasPass: boolean;
  phase: string;
  passId: string;
  passName: string;
  merkleRoot: string;
  memberCount: number;
  eligibleProofs: number;
  claimCount: number;
  commitments: string[];
  nullifiers: string[];
  revokedCount: number;
};

export type EngineStatus = {
  stage: Stage;
  membersRegistered: boolean;
  aliceProved: boolean;
  aliceClaimed: boolean;
  bobProveTried: boolean;
  bobClaimTried: boolean;
  disclosed: boolean;
};

export type ClaimRecord = { nullifier: string; salt: string; fingerprint: string };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class DemoEngine {
  private sim: VeilIdSimulator | null = null;
  private adminSk: Uint8Array = randomBytes(32);
  private keys: Record<PersonaId, Uint8Array> = {
    alice: randomBytes(32),
    carol: randomBytes(32),
    dave: randomBytes(32),
    bob: randomBytes(32),
  };
  private stage: Stage = "fresh";
  private aliceClaim: ClaimRecord | null = null;
  private disclosed: ClaimRecord | null = null;
  private flags = { aliceProved: false, bobProveTried: false, bobClaimTried: false };

  reset(): void {
    this.sim = null;
    this.adminSk = randomBytes(32);
    this.keys = {
      alice: randomBytes(32),
      carol: randomBytes(32),
      dave: randomBytes(32),
      bob: randomBytes(32),
    };
    this.stage = "fresh";
    this.aliceClaim = null;
    this.disclosed = null;
    this.flags = { aliceProved: false, bobProveTried: false, bobClaimTried: false };
  }

  status(): EngineStatus {
    return {
      stage: this.stage,
      membersRegistered: this.stage !== "fresh" && this.stage !== "created",
      aliceProved: this.flags.aliceProved,
      aliceClaimed: this.aliceClaim !== null,
      bobProveTried: this.flags.bobProveTried,
      bobClaimTried: this.flags.bobClaimTried,
      disclosed: this.disclosed !== null,
    };
  }

  snapshot(): LedgerSnapshot {
    if (!this.sim) {
      return {
        hasPass: false,
        phase: "—",
        passId: "—",
        passName: "—",
        merkleRoot: "—",
        memberCount: 0,
        eligibleProofs: 0,
        claimCount: 0,
        commitments: [],
        nullifiers: [],
        revokedCount: 0,
      };
    }
    const l = this.sim.getLedger();
    const root = l.members.root() as unknown as { field?: bigint };
    return {
      hasPass: true,
      phase: Phase[l.phase],
      passId: shortHex(l.passId),
      passName: l.passName,
      merkleRoot:
        typeof root?.field === "bigint" ? `0x${root.field.toString(16).padStart(64, "0").slice(0, 16)}…` : "—",
      memberCount: Number(l.memberCount),
      eligibleProofs: Number(l.eligibleProofs),
      claimCount: Number(l.claimCount),
      commitments: [...l.commitments].map(shortHex),
      nullifiers: [...l.nullifiers].map(shortHex),
      revokedCount: Number(l.revoked.size()),
    };
  }

  async createPass(): Promise<StepResult> {
    if (this.sim) return { ok: false, title: "Pass already exists", detail: "Reset the demo to start a fresh run." };
    const passId = randomBytes(32);
    this.sim = await VeilIdSimulator.create(this.adminSk, {
      passId,
      passName: "VeilID Agent Pass #1",
      openRegistration: false,
    });
    this.stage = "created";
    return {
      ok: true,
      title: "Pass created",
      detail:
        "“VeilID Agent Pass #1” is live in REGISTRATION. The issuer's admin key is derived from its secret — the secret itself is never published. Self-registration is off: this is a curated pass, the issuer registers members.",
      publicEffect: "Public ledger: passId, passName, phase = REGISTRATION, admin key hash.",
    };
  }

  async registerMembers(): Promise<StepResult> {
    if (!this.sim) return { ok: false, title: "No pass yet", detail: "Create the pass first." };
    if (this.stage !== "created")
      return { ok: false, title: "Registration is closed", detail: "Members can only be registered while the pass is in REGISTRATION." };
    try {
      const sim = this.sim;
      for (const id of ["alice", "carol", "dave"] as const) {
        await sim.as(this.adminSk).registerCommitment(sim.commitmentOf(this.keys[id]));
      }
      this.stage = "registered";
      const cs = (["alice", "carol", "dave"] as const).map(
        (id) => `${PERSONAS[id].name.split(" — ")[0]}: ${shortHex(sim.commitmentOf(this.keys[id]))}`,
      );
      return {
        ok: true,
        title: "3 members registered",
        detail: `The issuer registered Alice, Carol and Dave. Each gave the issuer only their commitment — a hash. No wallet, no Agent ID, no secret key was ever handed over.\n${cs.join("\n")}`,
        publicEffect: "Public ledger: 3 opaque commitments in the members Merkle tree, memberCount = 3.",
      };
    } catch (e) {
      return { ok: false, title: "Registration failed", detail: "The contract rejected the registration.", error: errText(e) };
    }
  }

  async openClaiming(): Promise<StepResult> {
    if (!this.sim) return { ok: false, title: "No pass yet", detail: "Create the pass first." };
    if (this.stage !== "registered")
      return { ok: false, title: "Cannot open claiming", detail: "Register members first — a pass with no members cannot open claiming." };
    try {
      await this.sim.as(this.adminSk).openClaiming();
      this.stage = "claiming";
      return {
        ok: true,
        title: "Claiming is open",
        detail: "Phase is now CLAIMING. Registration is closed — no new members can join this pass. Holders can now prove eligibility and claim.",
        publicEffect: "Public ledger: phase = CLAIMING.",
      };
    } catch (e) {
      return { ok: false, title: "Could not open claiming", detail: "The contract rejected the phase change.", error: errText(e) };
    }
  }

  async closePass(): Promise<StepResult> {
    if (!this.sim) return { ok: false, title: "No pass yet", detail: "Create the pass first." };
    if (this.stage !== "claiming")
      return { ok: false, title: "Cannot close", detail: "Only a pass in CLAIMING can be closed." };
    try {
      await this.sim.as(this.adminSk).closePass();
      this.stage = "closed";
      return {
        ok: true,
        title: "Pass closed",
        detail: "Phase is now CLOSED. No more proofs or claims are accepted. The ledger stays readable forever.",
        publicEffect: "Public ledger: phase = CLOSED.",
      };
    } catch (e) {
      return { ok: false, title: "Could not close", detail: "The contract rejected the phase change.", error: errText(e) };
    }
  }

  async proveEligible(id: PersonaId): Promise<StepResult> {
    if (!this.sim) return { ok: false, title: "No pass yet", detail: "Create the pass first." };
    if (this.stage !== "claiming")
      return { ok: false, title: "Claiming is not open", detail: "Eligibility can only be proven while the pass is in CLAIMING." };
    const before = Number(this.sim.getLedger().eligibleProofs);
    try {
      await this.sim.as(this.keys[id]).proveEligible();
      if (id === "alice") this.flags.aliceProved = true;
      if (id === "bob") this.flags.bobProveTried = true;
      return {
        ok: true,
        title: "eligible: true",
        detail:
          "The ZK proof attests “this secret key belongs to one of the registered commitments”. The proof does not say which commitment, which wallet, or which Agent ID — Alice stays anonymous among all members.",
        publicEffect: `Public ledger: eligibleProofs ${before} → ${before + 1}. Nothing else changed.`,
      };
    } catch (e) {
      if (id === "bob") this.flags.bobProveTried = true;
      return {
        ok: false,
        title: "Not eligible",
        detail:
          "Bob's secret key is not in the members tree, so the honest client cannot even build a membership proof — and the circuit would reject a forged one. In plain language: Bob was never registered, so he cannot prove eligibility.",
        error: errText(e),
      };
    }
  }

  async claim(id: PersonaId): Promise<StepResult> {
    if (!this.sim) return { ok: false, title: "No pass yet", detail: "Create the pass first." };
    if (this.stage !== "claiming")
      return { ok: false, title: "Claiming is not open", detail: "Claims are only accepted while the pass is in CLAIMING." };
    const before = Number(this.sim.getLedger().claimCount);
    try {
      await this.sim.as(this.keys[id]).claim();
      const nullifier = this.sim.nullifierOf(this.keys[id]);
      if (id === "alice") {
        const salt = randomBytes(32);
        this.aliceClaim = {
          nullifier: hex(nullifier),
          salt: hex(salt),
          fingerprint: hex(this.sim.auditFingerprintOf(nullifier, salt)),
        };
      }
      if (id === "bob") this.flags.bobClaimTried = true;
      return {
        ok: true,
        title: "Claim accepted",
        detail: `One claim recorded. Its nullifier is now on the public ledger: ${shortHex(nullifier)}. The nullifier cannot be linked back to any registration commitment — different domain tag, different hash.`,
        publicEffect: `Public ledger: nullifiers += 1, claimCount ${before} → ${before + 1}.`,
      };
    } catch (e) {
      if (id === "bob") this.flags.bobClaimTried = true;
      const msg = errText(e);
      const alreadyClaimed = /already claimed/.test(msg);
      return {
        ok: false,
        title: alreadyClaimed ? "Already claimed" : "Claim rejected",
        detail: alreadyClaimed
          ? "Alice's second claim produces the exact same nullifier as her first, and the ledger already holds it — so it is rejected. One holder, one claim, still anonymous: nobody can tell the two attempts came from the same person, only that this nullifier was already spent."
          : "Bob was never registered, so no membership proof can be built for him and the claim is rejected.",
        error: msg,
      };
    }
  }

  /** Alice hands (nullifier, salt, fingerprint) to the auditor off-chain. */
  discloseToAuditor(): ClaimRecord | null {
    if (!this.aliceClaim) return null;
    this.disclosed = { ...this.aliceClaim };
    return this.disclosed;
  }

  getDisclosure(): ClaimRecord | null {
    return this.disclosed;
  }

  getAliceClaim(): ClaimRecord | null {
    return this.aliceClaim;
  }

  verifyAudit(
    nullifierHex: string,
    saltHex: string,
    fingerprintHex: string,
  ): { match: boolean; reason: string } {
    if (!this.sim) return { match: false, reason: "No pass exists yet — run the demo first." };
    const nul = hexToBytes(nullifierHex);
    const salt = hexToBytes(saltHex);
    const fp = hexToBytes(fingerprintHex);
    if (!nul || !salt || !fp) {
      return { match: false, reason: "One of the three values is not a valid 32-byte hex string." };
    }
    const recomputed = hex(this.sim.auditFingerprintOf(nul, salt));
    const fingerprintMatches = recomputed === hex(fp);
    const onChain = this.sim.getLedger().nullifiers.member(nul);
    if (fingerprintMatches && onChain) {
      return {
        match: true,
        reason: "MATCH — the recomputed fingerprint equals the disclosed one, and the nullifier is on the public ledger. This claim is real, and it was disclosed by its holder. The auditor still learns nothing about the wallet, the secret key, or which commitment claimed.",
      };
    }
    if (!fingerprintMatches && onChain) {
      return {
        match: false,
        reason: "NO MATCH — the nullifier is on chain, but the fingerprint does not recompute from this (nullifier, salt) pair. Something in the disclosed values was changed.",
      };
    }
    if (fingerprintMatches && !onChain) {
      return { match: false, reason: "NO MATCH — the fingerprint recomputes, but the nullifier is not on the public ledger. This claim never happened on chain." };
    }
    return { match: false, reason: "NO MATCH — the fingerprint does not recompute, and the nullifier is not on the public ledger." };
  }
}
