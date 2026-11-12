// SPDX-License-Identifier: Apache-2.0
// Tests for the demo engine — the exact flow the webapp UI drives, against
// the real compiled contract via the simulator (no wallet, no network).
import { describe, it, expect } from "vitest";
import { DemoEngine, hexToBytes } from "./demo.js";

describe("VeilID demo engine", () => {
  it("runs the full 4-role demo flow", async () => {
    const e = new DemoEngine();

    // 1 · Issuer
    expect((await e.createPass()).ok).toBe(true);
    expect((await e.registerMembers()).ok).toBe(true);
    expect(e.snapshot().memberCount).toBe(3);
    expect((await e.openClaiming()).ok).toBe(true);
    expect(e.snapshot().phase).toBe("CLAIMING");

    // 2 · Alice: prove + claim once, second claim rejected
    const prove = await e.proveEligible("alice");
    expect(prove.ok).toBe(true);
    expect(prove.title).toBe("eligible: true");
    expect(e.snapshot().eligibleProofs).toBe(1);
    const claim = await e.claim("alice");
    expect(claim.ok).toBe(true);
    expect(e.snapshot().claimCount).toBe(1);
    expect(e.snapshot().nullifiers).toHaveLength(1);
    const again = await e.claim("alice");
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already claimed/);
    expect(e.snapshot().claimCount).toBe(1);

    // 3 · Bob: rejected twice
    const bobProve = await e.proveEligible("bob");
    expect(bobProve.ok).toBe(false);
    expect(bobProve.error).toMatch(/not registered/);
    const bobClaim = await e.claim("bob");
    expect(bobClaim.ok).toBe(false);
    expect(e.snapshot().claimCount).toBe(1);

    // 4 · Auditor: disclosed claim verifies; tampered salt does not
    const rec = e.discloseToAuditor();
    expect(rec).not.toBeNull();
    expect(e.verifyAudit(rec!.nullifier, rec!.salt, rec!.fingerprint).match).toBe(true);
    const tampered = rec!.salt.slice(0, -1) + (rec!.salt.slice(-1) === "0" ? "1" : "0");
    expect(e.verifyAudit(rec!.nullifier, tampered, rec!.fingerprint).match).toBe(false);
    // unknown nullifier does not verify either
    expect(e.verifyAudit("00".repeat(32), rec!.salt, rec!.fingerprint).match).toBe(false);
  });

  it("guards the demo order (no pass → no actions)", async () => {
    const e = new DemoEngine();
    expect((await e.registerMembers()).ok).toBe(false);
    expect((await e.openClaiming()).ok).toBe(false);
    expect((await e.proveEligible("alice")).ok).toBe(false);
    expect((await e.claim("alice")).ok).toBe(false);
    expect(e.discloseToAuditor()).toBeNull();
    expect(e.snapshot().hasPass).toBe(false);
  });

  it("reset starts a fresh run with new keys", async () => {
    const e = new DemoEngine();
    await e.createPass();
    await e.registerMembers();
    const before = e.snapshot().commitments;
    e.reset();
    expect(e.snapshot().hasPass).toBe(false);
    await e.createPass();
    await e.registerMembers();
    expect(e.snapshot().commitments).not.toEqual(before);
  });

  it("hexToBytes rejects malformed input", () => {
    expect(hexToBytes("zz")).toBeNull();
    expect(hexToBytes("abcd")).toBeNull(); // too short
    expect(hexToBytes("00".repeat(32))?.length).toBe(32);
  });
});
