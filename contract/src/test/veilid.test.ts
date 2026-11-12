import { describe, it, expect, beforeEach } from "vitest";
import { VeilIdSimulator, type PassConfig } from "../simulator.js";
import { randomBytes, hex } from "./utils.js";
import { Phase, pureCircuits } from "../managed/veilid/contract/index.js";
import { witnesses } from "../witnesses.js";

const cfg = (over: Partial<PassConfig> = {}): PassConfig => ({
  passId: randomBytes(32),
  passName: "VeilID Agent Pass",
  openRegistration: true,
  ...over,
});

/** A pass with three registered members, claiming open. */
const openPass = async () => {
  const adminSk = randomBytes(32);
  const sim = await VeilIdSimulator.create(adminSk, cfg());
  const [alice, bob, carol] = [randomBytes(32), randomBytes(32), randomBytes(32)];
  for (const m of [alice, bob, carol]) await sim.as(m).register();
  await sim.as(adminSk).openClaiming();
  return { adminSk, sim, alice, bob, carol };
};

describe("VeilID: setup", () => {
  it("initializes ledger from constructor args", async () => {
    const adminSk = randomBytes(32);
    const c = cfg();
    const sim = await VeilIdSimulator.create(adminSk, c);
    const l = sim.getLedger();
    expect(l.phase).toEqual(Phase.REGISTRATION);
    expect(l.passName).toEqual(c.passName);
    expect(l.openRegistration).toEqual(true);
    expect(l.passId).toEqual(c.passId);
    expect(l.admin).toEqual(pureCircuits.adminKey(c.passId, adminSk));
    expect(l.memberCount).toEqual(0n);
    expect(l.claimCount).toEqual(0n);
    expect(l.eligibleProofs).toEqual(0n);
    expect(l.nullifiers.isEmpty()).toBe(true);
    expect(l.revoked.isEmpty()).toBe(true);
  });

  it("is deterministic for the same inputs", async () => {
    const sk = randomBytes(32);
    const c = cfg();
    const snap = async (s: Promise<VeilIdSimulator>) => {
      const l = (await s).getLedger();
      return [l.passId, l.passName, l.openRegistration, l.admin, l.phase, l.members.root(), l.memberCount, l.claimCount];
    };
    expect(await snap(VeilIdSimulator.create(sk, c))).toEqual(await snap(VeilIdSimulator.create(sk, c)));
  });
});

describe("VeilID: registration", () => {
  let adminSk: Uint8Array;
  beforeEach(() => {
    adminSk = randomBytes(32);
  });

  it("self-registration publishes only a commitment", async () => {
    const sim = await VeilIdSimulator.create(adminSk, cfg());
    const alice = randomBytes(32);
    const l = await sim.as(alice).register();
    expect(l.memberCount).toEqual(1n);
    expect(l.commitments.member(sim.commitmentOf(alice))).toBe(true);
    expect(l.members.findPathForLeaf(sim.commitmentOf(alice))).toBeDefined();
    // commitment and nullifier are distinct values (domain separation)
    expect(hex(sim.commitmentOf(alice))).not.toEqual(hex(sim.nullifierOf(alice)));
    expect(hex(sim.commitmentOf(alice))).not.toEqual(hex(alice));
  });

  it("rejects duplicate registration", async () => {
    const sim = await VeilIdSimulator.create(adminSk, cfg());
    const alice = randomBytes(32);
    await sim.as(alice).register();
    await expect(sim.as(alice).register()).rejects.toThrow(/already registered/);
  });

  it("rejects self-registration when disabled", async () => {
    const sim = await VeilIdSimulator.create(adminSk, cfg({ openRegistration: false }));
    await expect(sim.as(randomBytes(32)).register()).rejects.toThrow(/self-registration disabled/);
  });

  it("admin can register a commitment; others cannot", async () => {
    const sim = await VeilIdSimulator.create(adminSk, cfg({ openRegistration: false }));
    const bob = randomBytes(32);
    const mallory = randomBytes(32);
    await expect(sim.as(mallory).registerCommitment(sim.commitmentOf(mallory))).rejects.toThrow(/not the admin/);
    const l = await sim.as(adminSk).registerCommitment(sim.commitmentOf(bob));
    expect(l.memberCount).toEqual(1n);
    await expect(sim.as(adminSk).registerCommitment(sim.commitmentOf(bob))).rejects.toThrow(/already registered/);
  });

  it("closes registration once claiming opens", async () => {
    const sim = await VeilIdSimulator.create(adminSk, cfg());
    await sim.as(randomBytes(32)).register();
    await sim.as(adminSk).openClaiming();
    await expect(sim.as(randomBytes(32)).register()).rejects.toThrow(/registration is closed/);
    await expect(sim.as(adminSk).registerCommitment(randomBytes(32))).rejects.toThrow(/registration is closed/);
  });
});

describe("VeilID: phases", () => {
  it("only admin can open/close, in order", async () => {
    const adminSk = randomBytes(32);
    const sim = await VeilIdSimulator.create(adminSk, cfg());
    await expect(sim.as(adminSk).openClaiming()).rejects.toThrow(/no members/);
    await sim.as(randomBytes(32)).register();
    await expect(sim.as(randomBytes(32)).openClaiming()).rejects.toThrow(/not the admin/);
    await expect(sim.as(adminSk).closePass()).rejects.toThrow(/not in claiming/);
    expect((await sim.as(adminSk).openClaiming()).phase).toEqual(Phase.CLAIMING);
    await expect(sim.as(adminSk).openClaiming()).rejects.toThrow(/not in registration/);
    await expect(sim.as(randomBytes(32)).closePass()).rejects.toThrow(/not the admin/);
    expect((await sim.as(adminSk).closePass()).phase).toEqual(Phase.CLOSED);
  });
});

describe("VeilID: eligibility", () => {
  it("a member can prove eligibility; only the counter moves", async () => {
    const { sim, alice } = await openPass();
    const l = await sim.as(alice).proveEligible();
    expect(l.eligibleProofs).toEqual(1n);
    expect(l.claimCount).toEqual(0n);
    expect(l.nullifiers.isEmpty()).toBe(true);
    // proving eligibility does not spend the claim
    await sim.as(alice).claim();
    expect(sim.getLedger().claimCount).toEqual(1n);
  });

  it("rejects eligibility proofs before claiming opens", async () => {
    const sim = await VeilIdSimulator.create(randomBytes(32), cfg());
    const alice = randomBytes(32);
    await sim.as(alice).register();
    await expect(sim.as(alice).proveEligible()).rejects.toThrow(/claiming is not open/);
  });

  it("honest witness refuses a non-member", async () => {
    const { sim } = await openPass();
    await expect(sim.as(randomBytes(32)).proveEligible()).rejects.toThrow(/not registered/);
  });

  it("circuit rejects a forged Merkle path from another tree", async () => {
    const { sim, alice } = await openPass();
    // Mallory registers in a different pass instance with the same passId,
    // then feeds that tree's path to the real pass.
    const mallory = randomBytes(32);
    const shadow = await VeilIdSimulator.create(randomBytes(32), sim.config);
    await shadow.as(mallory).register();
    const forgedPath = shadow.getLedger().members.findPathForLeaf(shadow.commitmentOf(mallory))!;

    sim.withWitnesses({ ...witnesses, findMembershipPath: ({ privateState }) => [privateState, forgedPath] });
    await expect(sim.as(mallory).proveEligible()).rejects.toThrow(/not a registered member/);
    await expect(sim.as(mallory).claim()).rejects.toThrow(/not a registered member/);
    void alice;
  });

  it("circuit rejects borrowing another member's path", async () => {
    const { sim, alice } = await openPass();
    const mallory = randomBytes(32);
    sim.withWitnesses({
      ...witnesses,
      findMembershipPath: ({ privateState, ledger }) => [
        privateState,
        ledger.members.findPathForLeaf(sim.commitmentOf(alice))!,
      ],
    });
    await expect(sim.as(mallory).proveEligible()).rejects.toThrow(/path does not match member/);
  });
});

describe("VeilID: claiming", () => {
  it("first claim succeeds and records the nullifier", async () => {
    const { sim, alice, bob } = await openPass();
    await sim.as(alice).claim();
    const l = await sim.as(bob).claim();
    expect(l.claimCount).toEqual(2n);
    expect(l.nullifiers.size()).toEqual(2n);
    for (const m of [alice, bob]) expect(l.nullifiers.member(sim.nullifierOf(m))).toBe(true);
  });

  it("blocks a second claim from the same secret, even after proving eligibility", async () => {
    const { sim, alice } = await openPass();
    await sim.as(alice).proveEligible();
    await sim.as(alice).claim();
    await expect(sim.as(alice).claim()).rejects.toThrow(/already claimed/);
    await expect(sim.as(alice).proveEligible()).resolves.not.toThrow();
    expect(sim.getLedger().claimCount).toEqual(1n);
  });

  it("rejects claims before claiming opens and after the pass closes", async () => {
    const adminSk = randomBytes(32);
    const sim = await VeilIdSimulator.create(adminSk, cfg());
    const alice = randomBytes(32);
    await sim.as(alice).register();
    await expect(sim.as(alice).claim()).rejects.toThrow(/claiming is not open/);
    await sim.as(adminSk).openClaiming();
    await sim.as(alice).claim();
    await sim.as(adminSk).closePass();
    await expect(sim.as(randomBytes(32)).claim()).rejects.toThrow(/claiming is not open/);
    expect(sim.getLedger().claimCount).toEqual(1n);
  });

  it("ledger never contains secret keys", async () => {
    const { adminSk, sim, alice, bob, carol } = await openPass();
    await sim.as(alice).proveEligible();
    await sim.as(alice).claim();
    const l = sim.getLedger();
    const pub = [...l.commitments].concat([...l.nullifiers], [l.admin]).map(hex);
    for (const sk of [alice, bob, carol, adminSk]) expect(pub).not.toContain(hex(sk));
  });
});

describe("VeilID: revocation", () => {
  it("admin can revoke; a revoked member cannot claim or prove eligibility", async () => {
    const { adminSk, sim, alice, bob } = await openPass();
    const l = await sim.as(adminSk).revokeCommitment(sim.commitmentOf(alice));
    expect(l.revoked.member(sim.commitmentOf(alice))).toBe(true);
    await expect(sim.as(alice).claim()).rejects.toThrow(/revoked/);
    await expect(sim.as(alice).proveEligible()).rejects.toThrow(/revoked/);
    // other members are unaffected
    expect((await sim.as(bob).claim()).claimCount).toEqual(1n);
  });

  it("only admin can revoke, and only known, unrevoked commitments", async () => {
    const { adminSk, sim, alice } = await openPass();
    await expect(sim.as(alice).revokeCommitment(sim.commitmentOf(alice))).rejects.toThrow(/not the admin/);
    await expect(sim.as(adminSk).revokeCommitment(randomBytes(32))).rejects.toThrow(/unknown commitment/);
    await sim.as(adminSk).revokeCommitment(sim.commitmentOf(alice));
    await expect(sim.as(adminSk).revokeCommitment(sim.commitmentOf(alice))).rejects.toThrow(/already revoked/);
  });

  it("revocation is refused once the pass is closed", async () => {
    const { adminSk, sim, alice } = await openPass();
    await sim.as(adminSk).closePass();
    await expect(sim.as(adminSk).revokeCommitment(sim.commitmentOf(alice))).rejects.toThrow(/pass is closed/);
  });
});

describe("VeilID: unlinkability helpers", () => {
  it("same key gives different commitments/nullifiers in different passes", () => {
    const sk = randomBytes(32);
    const [p1, p2] = [randomBytes(32), randomBytes(32)];
    expect(hex(pureCircuits.memberCommitment(p1, sk))).not.toEqual(hex(pureCircuits.memberCommitment(p2, sk)));
    expect(hex(pureCircuits.claimNullifier(p1, sk))).not.toEqual(hex(pureCircuits.claimNullifier(p2, sk)));
  });

  it("commitment, nullifier and audit fingerprint are mutually unlinkable", async () => {
    const { sim, alice } = await openPass();
    const c = sim.commitmentOf(alice);
    const n = sim.nullifierOf(alice);
    const salt1 = randomBytes(32);
    const salt2 = randomBytes(32);
    const fp1 = sim.auditFingerprintOf(n, salt1);
    const fp2 = sim.auditFingerprintOf(n, salt2);
    expect(hex(c)).not.toEqual(hex(n));
    expect(hex(fp1)).not.toEqual(hex(n));
    expect(hex(fp1)).not.toEqual(hex(c));
    // same inputs -> same fingerprint (auditor can recompute it)
    expect(hex(fp1)).toEqual(hex(sim.auditFingerprintOf(n, salt1)));
    // different salt -> different fingerprint
    expect(hex(fp1)).not.toEqual(hex(fp2));
    // fingerprint verifies against the on-chain nullifier after a claim
    await sim.as(alice).claim();
    expect(sim.getLedger().nullifiers.member(n)).toBe(true);
    expect(hex(sim.auditFingerprintOf(n, salt1))).toEqual(hex(fp1));
  });
});
