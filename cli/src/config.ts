// SPDX-License-Identifier: Apache-2.0
// VeilID CLI — Preview (ledger-9) environment configuration.
// Adapted from the NightPoll CLI pattern (Apache-2.0, hycorange/nightpoll),
// updated to Midnight.js 5.0.0 / wallet SDK 2.0.0 / ledger-9 provider APIs.
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EnvironmentConfiguration } from "@midnight-ntwrk/testkit-js";

/** Midnight Preview testnet (ledger 9, relaunched 2026-11-07). */
export const PREVIEW_ENV: EnvironmentConfiguration = {
  walletNetworkId: "preview",
  networkId: "preview",
  indexer: "https://indexer.preview.midnight.network/api/v4/graphql",
  indexerWS: "wss://indexer.preview.midnight.network/api/v4/graphql/ws",
  node: "https://rpc.preview.midnight.network",
  nodeWS: "wss://rpc.preview.midnight.network",
  proofServer: "http://127.0.0.1:6300",
  faucet: "https://faucet.preview.midnight.network",
};

export const NETWORK_ID = "preview";
/** How long a built transaction stays valid (seconds). */
export const TTL_SECONDS = 300;

/** Local-only home for the CLI wallet + private-state DB. Outside the repo. */
export const VEILID_HOME = join(homedir(), ".veilid");
/** Master seed for the Preview testnet wallet. chmod 600. NEVER in the repo. */
export const SEED_PATH = join(VEILID_HOME, "preview-seed");
/** LevelDB dir for contract private states + signing keys. */
export const LEVELDB_PATH = join(VEILID_HOME, "leveldb");

/** Compiled contract artifacts (keys/zkir/compiler manifest) — source of truth. */
export const MANAGED_DIR = fileURLToPath(
  new URL("../../contract/src/managed/veilid", import.meta.url),
);

/** Deployment record written by `deploy` / `demo` (same folder as NightPoll's). */
export const DEPLOYMENT_PATH = fileURLToPath(
  new URL("../../deployments/preview.json", import.meta.url),
);

/** Local proof server (official midnightntwrk/proof-server:9.0.0, no docker). */
export const PROOF_SERVER_URL = "http://127.0.0.1:6300";
