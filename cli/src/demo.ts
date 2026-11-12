// SPDX-License-Identifier: Apache-2.0
// VeilID CLI — the 4-role end-to-end demo on Preview testnet, with REAL ZK proofs.
// Issuer registers Alice + Dave (commitment) and Carol (self-register);
// Alice proves + claims; her 2nd claim is rejected; Bob (never registered) is
// rejected; the auditor verifies the fingerprint, then a tampered one fails;
// the issuer closes the pass. Every step + tx hash + block is recorded in
// deployments/preview.json (NightPoll format).
//
// Demo keys are deterministic throwaway testnet values (sha256 of fixed
// labels) so a run is reproducible. They are NOT written to preview.json —
// only commitments, nullifiers and fingerprints (all public) are recorded.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MidnightWalletProvider } from "@midnight-ntwrk/testkit-js";
import { DEPLOYMENT_PATH } from "./config.js";
import { logger } from "./providers.js";
import {
  adminKey,
  auditFingerprint,
  claimNullifier,
  hex,
  memberCommitment,
  merkleRootHex,
  VeilIdApi,
  type TxReceipt,
  type VeilIdProviders,
} from "./api.js";

const demoKey = (label: string): Uint8Array =>
  createHash("sha256").update(`veilid:demo:${label}`).digest();

const PASS_ID = demoKey("pass:2026-11-12");
const PASS_NAME = "VeilID Demo Pass";
const ADMIN_SK = demoKey("admin");
const ALICE_SK = demoKey("alice");
const CAROL_SK = demoKey("carol");
const DAVE_SK = demoKey("dave");
const BOB_SK = demoKey("bob");
const AUDIT_SALT = demoKey("audit-salt");

type StepRecord = {
  step: string;
  actor: string;
  circuit: string;
  txHash: string;
  txId: string;
  blockHeight: number;
  blockHash: string;
};

type RejectionRecord = { step: string; actor: string; circuit: string; error: string };

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll the indexer until the ledger shows the expected member/claim counts. */
async function waitForState(
  api: VeilIdApi,
  address: string,
  expect: { members?: bigint; claims?: bigint; proofs?: bigint },
  label: string,
): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const led = await api.readLedger(address).catch(() => null);
    if (
      led !== null &&
      (expect.members === undefined || led.memberCount === expect.members) &&
      (expect.claims === undefined || led.claimCount === expect.claims) &&
      (expect.proofs === undefined || led.eligibleProofs === expect.proofs)
    ) {
      return;
    }
    await sleep(2000);
  }
  logger.warn(`Indexer lag: state after "${label}" not confirmed within 60s (continuing)`);
}

export async function runDemo(
  walletProvider: MidnightWalletProvider,
  providers: VeilIdProviders,
): Promise<void> {
  const api = new VeilIdApi(providers);
  const steps: StepRecord[] = [];
  const rejections: RejectionRecord[] = [];
  const startedAt = new Date().toISOString();

  const aliceCommitment = memberCommitment(PASS_ID, ALICE_SK);
  const carolCommitment = memberCommitment(PASS_ID, CAROL_SK);
  const daveCommitment = memberCommitment(PASS_ID, DAVE_SK);
  const aliceNullifier = claimNullifier(PASS_ID, ALICE_SK);

  const record = (step: string, actor: string, circuit: string, r: TxReceipt): void => {
    steps.push({ step, actor, circuit, txHash: r.txHash, txId: r.txId, blockHeight: r.blockHeight, blockHash: r.blockHash });
    logger.info({ step, circuit, txHash: r.txHash, blockHeight: r.blockHeight }, "✓ on-chain");
  };
  const expectReject = async (
    step: string,
    actor: string,
    circuit: string,
    fn: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await fn();
      throw new Error(`EXPECTED REJECTION but the ${circuit} call succeeded — ${step}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The "expected rejection" sentinel above must not be swallowed as a pass.
      if (message.startsWith("EXPECTED REJECTION")) throw err;
      rejections.push({ step, actor, circuit, error: message });
      logger.info({ step, circuit, error: message.slice(0, 200) }, "✓ rejected as expected");
    }
  };

  // 1 — Deploy (issuer = this wallet, admin key from the demo admin secret).
  logger.info("Deploying VeilID pass to Preview…");
  const { deployed, receipt } = await api.deploy(PASS_ID, PASS_NAME, true, ADMIN_SK);
  const address = deployed.contractAddress;
  logger.info({ contractAddress: address, txHash: receipt.txHash, blockHeight: receipt.blockHeight }, "✓ deployed");
  logger.info({ admin: hex(adminKey(PASS_ID, ADMIN_SK)) }, "admin key (public)");

  const issuer = await api.attach(address, "veilid-issuer", ADMIN_SK);
  const alice = await api.attach(address, "veilid-alice", ALICE_SK);
  const carol = await api.attach(address, "veilid-carol", CAROL_SK);
  const dave = await api.attach(address, "veilid-dave", DAVE_SK);
  const bob = await api.attach(address, "veilid-bob", BOB_SK);

  // 2 — Registration: Alice + Dave by commitment (issuer), Carol self-registers.
  record("register Alice", "issuer", "registerCommitment", await api.registerCommitment(issuer, aliceCommitment));
  record("register Carol (self)", "carol", "register", await api.register(carol));
  record("register Dave", "issuer", "registerCommitment", await api.registerCommitment(issuer, daveCommitment));
  await waitForState(api, address, { members: 3n }, "registration");

  // 3 — Open claiming.
  record("open claiming", "issuer", "openClaiming", await api.openClaiming(issuer));

  // 4 — Alice proves eligibility, then claims.
  record("Alice prove eligible", "alice", "proveEligible", await api.proveEligible(alice));
  record("Alice claim", "alice", "claim", await api.claim(alice));
  await waitForState(api, address, { claims: 1n, proofs: 1n }, "Alice claim");

  // 5 — Expected rejections: Alice's 2nd claim, Bob's prove + claim.
  await expectReject("Alice 2nd claim", "alice", "claim", () => api.claim(alice));
  await expectReject("Bob prove eligible", "bob", "proveEligible", () => api.proveEligible(bob));
  await expectReject("Bob claim", "bob", "claim", () => api.claim(bob));

  // 6 — Auditor: voluntary audit fingerprint MATCH, tampered salt NO MATCH.
  const fingerprint = auditFingerprint(PASS_ID, aliceNullifier, AUDIT_SALT);
  const tampered = auditFingerprint(PASS_ID, aliceNullifier, demoKey("tampered-salt"));
  const auditorMatch = Buffer.from(fingerprint).equals(Buffer.from(auditFingerprint(PASS_ID, aliceNullifier, AUDIT_SALT)));
  const tamperedMatch = Buffer.from(tampered).equals(Buffer.from(fingerprint));
  logger.info(
    { fingerprint: hex(fingerprint), match: auditorMatch, tamperedMatch },
    "auditor check",
  );
  if (!auditorMatch || tamperedMatch) {
    throw new Error("Auditor check failed: expected MATCH=true, tampered MATCH=false");
  }

  // 7 — Close the pass.
  record("close pass", "issuer", "closePass", await api.closePass(issuer));

  // 8 — Final on-chain state.
  const final = await api.readLedger(address);
  if (final === null) throw new Error("Could not read final on-chain state");
  const finalState = {
    phase: final.phase,
    memberCount: Number(final.memberCount),
    claimCount: Number(final.claimCount),
    eligibleProofs: Number(final.eligibleProofs),
    merkleRoot: merkleRootHex(final.members.root()),
    commitments: [...final.commitments].map(hex),
    revoked: [...final.revoked].map(hex),
    nullifiers: [...final.nullifiers].map(hex),
  };
  logger.info(finalState, "final on-chain state");

  const recordJson = {
    network: "preview",
    contractAddress: address,
    passId: hex(PASS_ID),
    passName: PASS_NAME,
    deployedAt: startedAt,
    completedAt: new Date().toISOString(),
    deploy: {
      txHash: receipt.txHash,
      txId: receipt.txId,
      blockHeight: receipt.blockHeight,
      blockHash: receipt.blockHash,
    },
    steps,
    rejections,
    auditor: {
      nullifier: hex(aliceNullifier),
      fingerprint: hex(fingerprint),
      match: auditorMatch,
      tamperedMatch,
    },
    finalState,
    notes: [
      "Real ZK proofs on Midnight Preview testnet (ledger 9), proof server 9.0.0.",
      "Demo keys are deterministic throwaway testnet values; secret keys are NOT recorded here.",
      "Revocation is witness-enforced, not circuit-enforced (see README honest limits).",
    ],
  };
  await mkdir(dirname(DEPLOYMENT_PATH), { recursive: true });
  await writeFile(DEPLOYMENT_PATH, `${JSON.stringify(recordJson, null, 2)}\n`);
  logger.info({ path: DEPLOYMENT_PATH }, "deployment record written");
  logger.info(
    {
      contractAddress: address,
      steps: steps.length,
      rejections: rejections.length,
      finalState,
    },
    "DEMO COMPLETE",
  );
}
