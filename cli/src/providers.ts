// SPDX-License-Identifier: Apache-2.0
// VeilID CLI — builds the Midnight.js 5 provider set (ledger 9).
// setNetworkId() is gone in v5: the network lives in providers.config.
// Private state is per-contract via provider.forContract() (v5), so callers
// attach with a privateStateId per role instead of setContractAddress().
import pino from "pino";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import type { MidnightWalletProvider } from "@midnight-ntwrk/testkit-js";
import { MANAGED_DIR, NETWORK_ID, PREVIEW_ENV, PROOF_SERVER_URL, TTL_SECONDS } from "./config.js";
import { privateStatePassword } from "./wallet.js";
import type { VeilIdCircuitId, VeilIdProviders } from "./api.js";

export const logger = pino({ transport: { target: "pino-pretty" } });

/** Fail fast if the local proof server is not answering. */
export async function requireProofServer(): Promise<void> {
  const res = await fetch(`${PROOF_SERVER_URL}/health`).catch(() => null);
  if (res === null || !res.ok) {
    throw new Error(
      `Proof server not reachable at ${PROOF_SERVER_URL} — start it first: ` +
        `~/workspace/tools/proof-server-9.0.0/proof-server.sh`,
    );
  }
}

export function buildProviders(
  walletProvider: MidnightWalletProvider,
  seed: string,
): VeilIdProviders {
  const zkConfigProvider = new NodeZkConfigProvider<VeilIdCircuitId>(MANAGED_DIR);
  const proofProvider = httpClientProofProvider(PROOF_SERVER_URL, zkConfigProvider);
  const publicDataProvider = indexerPublicDataProvider({
    queryURL: PREVIEW_ENV.indexer,
    subscriptionURL: PREVIEW_ENV.indexerWS,
  });
  const privateStateProvider = levelPrivateStateProvider({
    privateStoragePasswordProvider: async () => privateStatePassword(seed),
    // Per the level provider docs: use the wallet's coin public key as accountId.
    accountId: walletProvider.getCoinPublicKey(),
  });
  return {
    privateStateProvider,
    publicDataProvider,
    zkConfigProvider,
    proofProvider,
    walletProvider,
    midnightProvider: walletProvider,
    config: { networkId: NETWORK_ID, ttlSeconds: TTL_SECONDS },
    loggerProvider: logger,
  };
}
