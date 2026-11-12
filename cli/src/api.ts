// SPDX-License-Identifier: Apache-2.0
// VeilID CLI — on-chain API over the deployed VeilID contract (Midnight.js 5).
// Adapted from the NightPoll CLI pattern (Apache-2.0, hycorange/nightpoll),
// updated to ledger-9 `deployContract` / `findDeployedContract` / `callTx`
// and Compact.js 3.0.0 (`CompiledContract.make` + witnesses + assets path).
import { ContractState } from "@midnight-ntwrk/compact-runtime";
import {
  type CompiledContract as CompiledContractType,
  make as makeCompiledContract,
  withCompiledFileAssets,
  withWitnesses,
} from "@midnight-ntwrk/compact-js/effect/CompiledContract";
import {
  deployContract,
  findDeployedContract,
  type Ledger9ContractProviders,
  type Ledger9DeployedContract,
  type Ledger9FoundContract,
} from "@midnight-ntwrk/midnight-js-contracts";
import { pipe } from "effect/Function";
import {
  Contract,
  ledger,
  pureCircuits,
  witnesses,
  type Ledger,
  type VeilIdPrivateState,
} from "@veilid/contract";
import { MANAGED_DIR } from "./config.js";

export type VeilIdCircuitId =
  | "register"
  | "registerCommitment"
  | "revokeCommitment"
  | "openClaiming"
  | "closePass"
  | "proveEligible"
  | "claim";

export type VeilIdContract = Contract<VeilIdPrivateState>;

export type TxReceipt = {
  txHash: string;
  txId: string;
  blockHeight: number;
  blockHash: string;
};

export type VeilIdProviders = Ledger9ContractProviders<
  VeilIdContract,
  VeilIdCircuitId,
  VeilIdPrivateState
>;

const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** Merkle root digest ({ field: bigint }) as 32-byte hex. */
export const merkleRootHex = (root: { field: bigint }): string =>
  root.field.toString(16).padStart(64, "0");

/** Minimal public fields of a finalized call/deploy transaction. */
function receiptOf(tx: {
  public: { txHash: string; txId: string; blockHeight: number; blockHash: string };
}): TxReceipt {
  return {
    txHash: tx.public.txHash,
    txId: tx.public.txId,
    blockHeight: tx.public.blockHeight,
    blockHash: tx.public.blockHash,
  };
}

export class VeilIdApi {
  /** Compact.js 3.0.0 binding: generated contract + witnesses + ZK assets path. */
  private readonly compiledContract: CompiledContractType<
    VeilIdContract,
    VeilIdPrivateState,
    never
  > = pipe(
    makeCompiledContract<VeilIdContract, VeilIdPrivateState>("veilid", Contract),
    withWitnesses(witnesses),
    withCompiledFileAssets(MANAGED_DIR),
  );

  constructor(private readonly providers: VeilIdProviders) {}

  /** Deploy a fresh pass. Returns the deployed contract + deploy receipt. */
  async deploy(
    passId: Uint8Array,
    passName: string,
    openRegistration: boolean,
    adminSecretKey: Uint8Array,
  ): Promise<{ deployed: Ledger9DeployedContract<VeilIdContract>; receipt: TxReceipt }> {
    const deployed = await deployContract(this.providers, {
      compiledContract: this.compiledContract,
      privateStateId: "veilid-issuer",
      initialPrivateState: { secretKey: adminSecretKey },
      args: [passId, passName, openRegistration],
    });
    return { deployed, receipt: receiptOf(deployed.deployTxData) };
  }

  /** Attach to a deployed contract as one role, storing that role's private state. */
  async attach(
    contractAddress: string,
    privateStateId: string,
    secretKey: Uint8Array,
  ): Promise<Ledger9FoundContract<VeilIdContract>> {
    return findDeployedContract(this.providers, {
      compiledContract: this.compiledContract,
      contractAddress,
      privateStateId,
      initialPrivateState: { secretKey },
    });
  }

  /** Read + decode the current on-chain ledger state. */
  async readLedger(contractAddress: string): Promise<Ledger | null> {
    const read = await this.providers.publicDataProvider.queryContractState(contractAddress);
    if (read === null) return null;
    const decoded = read.contractState.deserialize({ v9: ContractState });
    return ledger(decoded.data);
  }

  // --- circuit calls (each returns the on-chain receipt) ---

  async register(contract: Ledger9FoundContract<VeilIdContract>): Promise<TxReceipt> {
    return receiptOf(await contract.callTx.register());
  }

  async registerCommitment(
    contract: Ledger9FoundContract<VeilIdContract>,
    commitment: Uint8Array,
  ): Promise<TxReceipt> {
    return receiptOf(await contract.callTx.registerCommitment(commitment));
  }

  async revokeCommitment(
    contract: Ledger9FoundContract<VeilIdContract>,
    commitment: Uint8Array,
  ): Promise<TxReceipt> {
    return receiptOf(await contract.callTx.revokeCommitment(commitment));
  }

  async openClaiming(contract: Ledger9FoundContract<VeilIdContract>): Promise<TxReceipt> {
    return receiptOf(await contract.callTx.openClaiming());
  }

  async closePass(contract: Ledger9FoundContract<VeilIdContract>): Promise<TxReceipt> {
    return receiptOf(await contract.callTx.closePass());
  }

  async proveEligible(contract: Ledger9FoundContract<VeilIdContract>): Promise<TxReceipt> {
    return receiptOf(await contract.callTx.proveEligible());
  }

  async claim(contract: Ledger9FoundContract<VeilIdContract>): Promise<TxReceipt> {
    return receiptOf(await contract.callTx.claim());
  }
}

// --- pure circuits (local, no proof, no chain) ---

export const memberCommitment = (passId: Uint8Array, sk: Uint8Array): Uint8Array =>
  pureCircuits.memberCommitment(passId, sk);

export const claimNullifier = (passId: Uint8Array, sk: Uint8Array): Uint8Array =>
  pureCircuits.claimNullifier(passId, sk);

export const adminKey = (passId: Uint8Array, sk: Uint8Array): Uint8Array =>
  pureCircuits.adminKey(passId, sk);

export const auditFingerprint = (
  passId: Uint8Array,
  nullifier: Uint8Array,
  salt: Uint8Array,
): Uint8Array => pureCircuits.auditFingerprint(passId, nullifier, salt);

export const hex = toHex;
