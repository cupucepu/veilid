// SPDX-License-Identifier: Apache-2.0
// VeilID CLI — Preview testnet wallet (Midnight.js 5 / wallet SDK 2.0.0).
// The wallet is created locally from a random master seed. The seed lives at
// ~/.veilid/preview-seed (chmod 600, outside the repo) and is NEVER printed,
// committed, or sent anywhere. Only the public addresses are reported.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
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
  timeoutMs = 240_000,
): Promise<void> {
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
 * Password for the LevelDB private-state store, derived from the wallet seed.
 * Meets the midnight-js password policy (16+ chars, upper/lower/digits).
 * It is derived at runtime, never written to disk.
 */
export function privateStatePassword(seed: string): string {
  return createHash("sha256").update(`veilid:private-state:${seed}`).digest("base64");
}
