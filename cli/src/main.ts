// SPDX-License-Identifier: Apache-2.0
// VeilID CLI — Preview testnet (ledger 9).
//
//   npm run veilid -- wallet    create/load the local wallet, print addresses + balances
//   npm run veilid -- faucet    try the Preview faucet (no captcha token; expected to fail)
//   npm run veilid -- fund      show balances + dust status, and what funding is needed
//   npm run veilid -- register-dust  register NIGHT for DUST generation + wait for accrual
//   npm run veilid -- deploy    deploy a fresh VeilID pass, record deployments/preview.json
//   npm run veilid -- demo      full 4-role e2e demo with real ZK proofs (deploy + all steps)
//   npm run veilid -- state <contractAddress>   read + print the on-chain ledger state
//
// Testnet only. The wallet seed lives at ~/.veilid/preview-seed (chmod 600,
// outside the repo) and is never printed. No GitHub / AKINDO action here.
// WebSocket shim first: the wallet SDK subscribes over the global WebSocket,
// which must tunnel through this VM's egress proxy (see ws-shim.ts).
import "./ws-shim.js";
import { createHash } from "node:crypto";
import type { MidnightWalletProvider } from "@midnight-ntwrk/testkit-js";
import { DEPLOYMENT_PATH, PREVIEW_ENV } from "./config.js";
import { buildProviders, logger, requireProofServer } from "./providers.js";
import {
  buildWalletProvider,
  getBalances,
  getDustAddress,
  getUnshieldedAddress,
  loadOrCreateSeed,
  registerDust,
  syncWalletState,
} from "./wallet.js";
import { VeilIdApi, hex, merkleRootHex } from "./api.js";
import { runDemo } from "./demo.js";

const usage = `VeilID CLI (Midnight Preview testnet, ledger 9)

  wallet                 create/load wallet, print addresses + balances
  faucet                 try the Preview faucet drip (no captcha token)
  fund                   show balances + dust status
  register-dust          register NIGHT for DUST generation + wait for accrual
  deploy                 deploy a fresh VeilID pass
  demo                   full 4-role e2e demo with real ZK proofs
  state <contractAddress>  read the on-chain ledger state
`;

async function withWallet<T>(
  fn: (walletProvider: MidnightWalletProvider, seed: string) => Promise<T>,
  opts: { sync?: boolean } = {},
): Promise<T> {
  const { seed, created } = await loadOrCreateSeed();
  if (created) logger.info("Created new Preview wallet (seed saved to ~/.veilid/preview-seed, chmod 600)");
  const walletProvider = await buildWalletProvider(logger, PREVIEW_ENV, seed);
  try {
    if (opts.sync !== false) {
      logger.info("Syncing wallet (shielded + unshielded + dust)…");
      await syncWalletState(walletProvider);
      logger.info("Wallet synced");
    }
    return await fn(walletProvider, seed);
  } finally {
    await walletProvider.stop().catch(() => undefined);
  }
}

function fmtBalances(b: Record<string, bigint>): string {
  const entries = Object.entries(b).map(([k, v]) => `${k}=${v.toString()}`);
  return entries.length > 0 ? entries.join(", ") : "(empty)";
}

async function cmdWallet(): Promise<void> {
  await withWallet(async (wp) => {
    const [unshielded, dust, balances] = await Promise.all([
      getUnshieldedAddress(wp, PREVIEW_ENV),
      getDustAddress(wp, PREVIEW_ENV),
      getBalances(wp, PREVIEW_ENV),
    ]);
    logger.info({ unshielded, dust }, "wallet addresses");
    logger.info(
      {
        unshielded: fmtBalances(balances.unshielded),
        shielded: fmtBalances(balances.shielded),
        dustBalance: balances.dust.balance.toString(),
        dustCap: balances.dust.cap.toString(),
      },
      "balances",
    );
    if (balances.unshielded && Object.values(balances.unshielded).every((v) => v === 0n)) {
      logger.warn(
        { faucet: PREVIEW_ENV.faucet, address: unshielded },
        "Wallet is empty — fund it from the Preview faucet (needs a human-solved captcha)",
      );
    }
  });
}

async function cmdFaucet(): Promise<void> {
  await withWallet(async (wp) => {
    const address = await getUnshieldedAddress(wp, PREVIEW_ENV);
    logger.info({ faucet: PREVIEW_ENV.faucet, address }, "requesting a drip (no captcha token)");
    // Faucet API (from the faucet SPA bundle): POST /api/drips, headers
    // Content-Type + X-Captcha-Token, body {recipientAddress, amount}.
    // The UI drips a fixed 1000 tNIGHT per request.
    const res = await fetch(`${PREVIEW_ENV.faucet}/api/drips`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipientAddress: address, amount: "1000" }),
      signal: AbortSignal.timeout(30_000),
    }).catch((err: unknown) => {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "faucet request failed (network)");
      return null;
    });
    if (res === null) return;
    const body = await res.text();
    logger.info({ status: res.status, body: body.slice(0, 500) }, "faucet response");
    if (!res.ok) {
      logger.warn(
        "Faucet rejected the programmatic drip (expected: it requires a Cloudflare Turnstile captcha token). " +
          `Human step: open ${PREVIEW_ENV.faucet} in a browser, solve the captcha, and paste this address: ${address}`,
      );
    }
  }, { sync: false });
}

async function cmdFund(): Promise<void> {
  await withWallet(async (wp) => {
    const [address, dust, balances] = await Promise.all([
      getUnshieldedAddress(wp, PREVIEW_ENV),
      getDustAddress(wp, PREVIEW_ENV),
      getBalances(wp, PREVIEW_ENV),
    ]);
    logger.info({ unshielded: address, dust }, "addresses");
    logger.info(
      {
        unshielded: fmtBalances(balances.unshielded),
        dustBalance: balances.dust.balance.toString(),
        dustCap: balances.dust.cap.toString(),
      },
      "balances",
    );
    logger.info(
      "DUST (the fee token) is NOT automatic: NIGHT UTxOs must be registered " +
        "for DUST generation first (`npm run veilid -- register-dust`, or the " +
        "deploy/demo commands do it for you). One standard faucet drip covers " +
        "deploy + the ~10 demo calls once DUST has accrued. If the wallet is empty, fund it at " +
        `${PREVIEW_ENV.faucet} (browser + captcha) with address ${address}.`,
    );
  });
}

async function cmdRegisterDust(): Promise<void> {
  await withWallet(async (wp) => {
    const { registrationTxId, dustBalance } = await registerDust(wp, logger);
    logger.info(
      { registrationTxId, dustBalanceSpecks: dustBalance.toString() },
      "dust registration done",
    );
  });
}

async function cmdDeploy(): Promise<void> {
  await requireProofServer();
  await withWallet(async (wp, seed) => {
    // Fees are paid in DUST: register first, or balanceTx rejects the deploy.
    await registerDust(wp, logger);
    const providers = buildProviders(wp, seed);
    const api = new VeilIdApi(providers);
    const passId = createHash("sha256").update("veilid:demo:pass:2026-11-12").digest();
    const adminSk = createHash("sha256").update("veilid:demo:admin").digest();
    const { deployed, receipt } = await api.deploy(passId, "VeilID Demo Pass", true, adminSk);
    logger.info(
      {
        contractAddress: deployed.contractAddress,
        passId: hex(passId),
        txHash: receipt.txHash,
        blockHeight: receipt.blockHeight,
      },
      "DEPLOYED — run `npm run veilid -- demo` for the full e2e flow, or `state` to read it",
    );
    logger.info({ deploymentRecord: DEPLOYMENT_PATH }, "note: full record is written by the demo command");
  });
}

async function cmdState(contractAddress: string): Promise<void> {
  await withWallet(async (wp, seed) => {
    const providers = buildProviders(wp, seed);
    const api = new VeilIdApi(providers);
    const led = await api.readLedger(contractAddress);
    if (led === null) {
      logger.warn({ contractAddress }, "no contract state found at this address");
      return;
    }
    logger.info(
      {
        contractAddress,
        passId: hex(led.passId),
        passName: led.passName,
        openRegistration: led.openRegistration,
        admin: hex(led.admin),
        phase: led.phase,
        memberCount: led.memberCount.toString(),
        claimCount: led.claimCount.toString(),
        eligibleProofs: led.eligibleProofs.toString(),
        merkleRoot: merkleRootHex(led.members.root()),
        commitments: [...led.commitments].map(hex),
        revoked: [...led.revoked].map(hex),
        nullifiers: [...led.nullifiers].map(hex),
      },
      "on-chain ledger state",
    );
  });
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "wallet":
      await cmdWallet();
      break;
    case "faucet":
      await cmdFaucet();
      break;
    case "fund":
      await cmdFund();
      break;
    case "register-dust":
      await cmdRegisterDust();
      break;
    case "deploy":
      await cmdDeploy();
      break;
    case "demo":
      await requireProofServer();
      await withWallet(async (wp, seed) => {
        // Fees are paid in DUST: register first, or balanceTx rejects the deploy.
        await registerDust(wp, logger);
        const providers = buildProviders(wp, seed);
        await runDemo(wp, providers);
      });
      break;
    case "state":
      if (!arg) throw new Error("usage: veilid state <contractAddress>");
      await cmdState(arg);
      break;
    default:
      process.stdout.write(usage);
      if (cmd !== undefined && cmd !== "help" && cmd !== "--help") {
        throw new Error(`unknown command: ${cmd}`);
      }
  }
}

main().catch((err: unknown) => {
  logger.error({ error: err instanceof Error ? err.message : String(err) }, "veilid CLI failed");
  process.exit(1);
});
