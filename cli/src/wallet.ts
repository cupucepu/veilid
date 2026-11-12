// SPDX-License-Identifier: Apache-2.0
// VeilID CLI — Preview testnet wallet (Midnight.js 5 / wallet SDK 2.0.0).
// The wallet is created locally from a random master seed. The seed lives at
// ~/.veilid/preview-seed (chmod 600, outside the repo) and is NEVER printed,
// committed, or sent anywhere. Only the public addresses are reported.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { firstValueFrom } from "rxjs";
import { isInsufficientDustForFeeError } from "@midnightntwrk/wallet-sdk";
import {
  DAppConnectorWalletAdapter,
  FluentWalletBuilder,
  MidnightWalletProvider,
  WalletSeeds,
  syncWallet,
  type EnvironmentConfiguration,
} from "@midnight-ntwrk/testkit-js";
import { SEED_PATH, VEILID_HOME } from "./config.js";

/** Load the existing master seed, or generate + save a new one (chmod 600). */
export async function loadOrCreateSeed(): Promise<{ seed: string; created: boolean }> {
  try {
    const seed = (await readFile(SEED_PATH, "utf8")).trim();
    if (seed.length > 0) return { seed, created: false };
  } catch {
    // No seed yet — fall through to creation.
  }
  const seed = WalletSeeds.generateRandom().masterSeed;
  await mkdir(VEILID_HOME, { mode: 0o700, recursive: true });
  await writeFile(SEED_PATH, `${seed}\n`, { mode: 0o600 });
  return { seed, created: true };
}

/**
 * Build + start the wallet provider WITHOUT waiting for funds.
 * Built via FluentWalletBuilder + withWallet on purpose: the
 * `MidnightWalletProvider.build` shortcut logs the master seed in plaintext.
 */
export async function buildWalletProvider(
  logger: Logger,
  env: EnvironmentConfiguration,
  seed: string,
): Promise<MidnightWalletProvider> {
  const builder = FluentWalletBuilder.forEnvironment(env);
  const { wallet, seeds, keystore } = await builder.withSeed(seed).buildWithoutStarting();
  const provider = await MidnightWalletProvider.withWallet(logger, env, wallet, seeds, keystore);
  await provider.start(false);
  return provider;
}

/** Wait until the wallet facade reports shielded + unshielded + dust synced. */
export async function syncWalletState(
  walletProvider: MidnightWalletProvider,
  timeoutMs = 600_000,
): Promise<void> {
  // 600s, not the SDK's 240s default: successful syncs on this VM take
  // 150–210s through the egress proxy, and the 02:09 UTC demo run tripped the
  // 240s timeout with dust still syncing (shielded + unshielded were done).
  await syncWallet(walletProvider.wallet, 2_000, timeoutMs);
}

/** Bech32m unshielded address (the one the faucet pays to). */
export async function getUnshieldedAddress(
  walletProvider: MidnightWalletProvider,
  env: EnvironmentConfiguration,
): Promise<string> {
  const adapter = new DAppConnectorWalletAdapter(walletProvider, env);
  const { unshieldedAddress } = await adapter.getUnshieldedAddress();
  return unshieldedAddress;
}

/** Bech32m dust address (DUST is the fee token on ledger 9). */
export async function getDustAddress(
  walletProvider: MidnightWalletProvider,
  env: EnvironmentConfiguration,
): Promise<string> {
  const adapter = new DAppConnectorWalletAdapter(walletProvider, env);
  const { dustAddress } = await adapter.getDustAddress();
  return dustAddress;
}

export async function getBalances(
  walletProvider: MidnightWalletProvider,
  env: EnvironmentConfiguration,
): Promise<{
  unshielded: Record<string, bigint>;
  shielded: Record<string, bigint>;
  dust: { cap: bigint; balance: bigint };
}> {
  const adapter = new DAppConnectorWalletAdapter(walletProvider, env);
  const [unshielded, shielded, dust] = await Promise.all([
    adapter.getUnshieldedBalances(),
    adapter.getShieldedBalances(),
    adapter.getDustBalance(),
  ]);
  return { unshielded, shielded, dust };
}

/**
 * Register the wallet's unregistered NIGHT UTxOs for DUST generation, then wait
 * until spendable DUST has accrued. REQUIRED before any transaction can be
 * submitted: on ledger 9, fees are paid in DUST, and holding tNIGHT alone
 * generates nothing — the UTxOs must be registered first (official docs:
 * "NIGHT that arrives on Midnight after the upgrade needs a first-time
 * registration for DUST generation", docs.midnight.network/relnotes/ledger-9).
 *
 * The registration pays its own fee out of the dust the UTxOs have generated
 * so far (fee-coverage guard). If that falls short but is reachable, wait for
 * generation to cover it and retry once (the pattern from the wallet SDK
 * facade docs). After the registration lands, DUST accrues over time, so this
 * also polls until the spendable balance is > 0 before returning.
 *
 * Diagnosed 2026-11-12: the 09:48 WITA demo deploy failed at balanceTx with
 * `Wallet.InsufficientFunds: could not balance dust` because the faucet
 * tNIGHT UTxO had `registeredForDustGeneration=false` and dust balance/cap 0.
 * The old claim "DUST registers automatically on the first transaction" is
 * false — registration is an explicit, separate transaction.
 */
const NIGHT_TOKEN_RAW =
  "0000000000000000000000000000000000000000000000000000000000000000";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function registerDust(
  walletProvider: MidnightWalletProvider,
  logger: Logger,
  opts: { waitTimeoutMs?: number } = {},
): Promise<{ registrationTxId: string | null; dustBalance: bigint }> {
  const facade = walletProvider.wallet;
  const keystore = walletProvider.unshieldedKeystore;

  const readDustBalance = async (): Promise<bigint> => {
    const s = await firstValueFrom(facade.state());
    return s.dust.balance(new Date());
  };

  const state = await firstValueFrom(facade.state());
  const unregistered = state.unshielded.availableCoins.filter(
    (c) => c.utxo.type === NIGHT_TOKEN_RAW && c.meta.registeredForDustGeneration === false,
  );

  let registrationTxId: string | null = null;
  if (unregistered.length === 0) {
    logger.info("NIGHT already registered for DUST generation — nothing to register");
  } else {
    logger.info(
      { count: unregistered.length },
      "Registering NIGHT UTxO(s) for DUST generation…",
    );
    const { fee } = await facade.estimateRegistration(unregistered);
    logger.info({ feeSpecks: fee.toString() }, "dust registration fee estimate");
    // Wait until the dust generated so far covers the registration's own fee.
    await facade.waitForGeneratedDust(unregistered, fee, { timeoutMs: 300_000 });
    const attempt = async (): Promise<string> => {
      const recipe = await facade.registerNightUtxosForDustGeneration(
        unregistered,
        keystore.getPublicKey(),
        (payload) => keystore.signDataAsync(payload),
      );
      const finalized = await facade.finalizeRecipe(recipe);
      return facade.submitTransaction(finalized);
    };
    try {
      registrationTxId = await attempt();
    } catch (err) {
      if (isInsufficientDustForFeeError(err) && err.estimate._tag === "Reachable") {
        const waitMs =
          Math.max(0, err.estimate.at.getTime() - Date.now()) + 60_000;
        logger.warn(
          { shortfallSpecks: err.shortfall.toString(), waitMs },
          "Registration fee not yet covered by generated dust — waiting, then retrying once",
        );
        await sleep(waitMs);
        registrationTxId = await attempt();
      } else {
        throw err;
      }
    }
    logger.info({ registrationTxId }, "dust registration tx submitted");
  }

  // DUST accrues over time after registration; wait until some is spendable.
  const waitTimeoutMs = opts.waitTimeoutMs ?? 600_000;
  const deadline = Date.now() + waitTimeoutMs;
  for (;;) {
    const bal = await readDustBalance();
    if (bal > 0n) {
      logger.info(
        { dustBalanceSpecks: bal.toString() },
        "DUST accrued — wallet can pay fees",
      );
      return { registrationTxId, dustBalance: bal };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for DUST to accrue after registration (balance still 0 after ${waitTimeoutMs / 1000}s). ` +
          `Registration tx: ${registrationTxId ?? "none (already registered)"}. DUST generation may need more time — retry later.`,
      );
    }
    await sleep(15_000);
  }
}

/**
 * Password for the LevelDB private-state store, derived from the wallet seed.
 * Meets the midnight-js password policy (16+ chars, upper/lower/digits).
 * It is derived at runtime, never written to disk.
 */
export function privateStatePassword(seed: string): string {
  return createHash("sha256").update(`veilid:private-state:${seed}`).digest("base64");
}
