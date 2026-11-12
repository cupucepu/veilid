// SPDX-License-Identifier: Apache-2.0
import {
  type ChargedState,
  type CircuitContext,
  type CircuitResults,
  CostModel,
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import {
  Contract,
  type Ledger,
  type Witnesses,
  ledger,
  pureCircuits,
} from "./managed/veilid/contract/index.js";
import { type VeilIdPrivateState, witnesses as defaultWitnesses } from "./witnesses.js";

export type PassConfig = {
  passId: Uint8Array;
  passName: string;
  openRegistration: boolean;
};

/** Dummy coin public key: the simulator never moves shielded coins. */
const DUMMY_COIN_PUBLIC_KEY = "0".repeat(64);

/**
 * In-memory test bed: runs circuits locally against a simulated ledger
 * (no proofs, no network). Compact runtime 0.21.0 made circuit execution
 * async, so the simulator is async too: create it with `VeilIdSimulator.create`
 * and `await` every circuit call.
 */
export class VeilIdSimulator {
  private contract: Contract<VeilIdPrivateState>;
  private contractState: ChargedState;
  private privateState: VeilIdPrivateState;

  private constructor(
    contract: Contract<VeilIdPrivateState>,
    contractState: ChargedState,
    privateState: VeilIdPrivateState,
    readonly config: PassConfig,
  ) {
    this.contract = contract;
    this.contractState = contractState;
    this.privateState = privateState;
  }

  static async create(adminSecretKey: Uint8Array, config: PassConfig): Promise<VeilIdSimulator> {
    const contract = new Contract<VeilIdPrivateState>(defaultWitnesses);
    const init = await contract.initialState(
      createConstructorContext({ secretKey: adminSecretKey }, DUMMY_COIN_PUBLIC_KEY),
      config.passId,
      config.passName,
      config.openRegistration,
    );
    return new VeilIdSimulator(
      contract,
      init.currentContractState.data,
      init.currentPrivateState,
      config,
    );
  }

  /** Act as a different user (different local secret key). */
  as(secretKey: Uint8Array): this {
    this.privateState = { secretKey };
    return this;
  }

  /** Swap in custom (e.g. malicious) witness implementations. */
  withWitnesses(w: Witnesses<VeilIdPrivateState>): this {
    this.contract = new Contract<VeilIdPrivateState>(w);
    return this;
  }

  getLedger(): Ledger {
    return ledger(this.contractState);
  }

  private async run(
    circuitId: string,
    f: (
      c: Contract<VeilIdPrivateState>,
      ctx: CircuitContext<VeilIdPrivateState>,
    ) => Promise<CircuitResults<VeilIdPrivateState, []>>,
  ): Promise<Ledger> {
    const ctx = createCircuitContext<VeilIdPrivateState>({
      circuitId,
      contractAddress: dummyContractAddress(),
      coinPublicKeyOrZswapState: DUMMY_COIN_PUBLIC_KEY,
      contractState: this.contractState,
      privateState: this.privateState,
      costModel: CostModel.initialCostModel(),
    });
    const results = await f(this.contract, ctx);
    this.contractState = results.context.callContext.currentQueryContext.state;
    const nextPrivate = results.context.callContext.currentPrivateState;
    if (nextPrivate !== undefined) this.privateState = nextPrivate;
    return this.getLedger();
  }

  register(): Promise<Ledger> {
    return this.run("register", (c, ctx) => c.impureCircuits.register(ctx));
  }
  registerCommitment(commitment: Uint8Array): Promise<Ledger> {
    return this.run("registerCommitment", (c, ctx) =>
      c.impureCircuits.registerCommitment(ctx, commitment),
    );
  }
  revokeCommitment(commitment: Uint8Array): Promise<Ledger> {
    return this.run("revokeCommitment", (c, ctx) =>
      c.impureCircuits.revokeCommitment(ctx, commitment),
    );
  }
  openClaiming(): Promise<Ledger> {
    return this.run("openClaiming", (c, ctx) => c.impureCircuits.openClaiming(ctx));
  }
  closePass(): Promise<Ledger> {
    return this.run("closePass", (c, ctx) => c.impureCircuits.closePass(ctx));
  }
  proveEligible(): Promise<Ledger> {
    return this.run("proveEligible", (c, ctx) => c.impureCircuits.proveEligible(ctx));
  }
  claim(): Promise<Ledger> {
    return this.run("claim", (c, ctx) => c.impureCircuits.claim(ctx));
  }

  commitmentOf(sk: Uint8Array): Uint8Array {
    return pureCircuits.memberCommitment(this.config.passId, sk);
  }
  nullifierOf(sk: Uint8Array): Uint8Array {
    return pureCircuits.claimNullifier(this.config.passId, sk);
  }
  auditFingerprintOf(nullifier: Uint8Array, salt: Uint8Array): Uint8Array {
    return pureCircuits.auditFingerprint(this.config.passId, nullifier, salt);
  }
}
