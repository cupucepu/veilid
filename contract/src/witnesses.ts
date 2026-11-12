// SPDX-License-Identifier: Apache-2.0
import type { WitnessContext, MerkleTreePath } from "@midnight-ntwrk/compact-runtime";
import type { Ledger, Witnesses } from "./managed/veilid/contract/index.js";

/** Private state kept only on the holder's device. */
export type VeilIdPrivateState = {
  readonly secretKey: Uint8Array;
};

export const createVeilIdPrivateState = (secretKey: Uint8Array): VeilIdPrivateState => ({
  secretKey,
});

export const witnesses: Witnesses<VeilIdPrivateState> = {
  localSecretKey: ({ privateState }: WitnessContext<Ledger, VeilIdPrivateState>) => [
    privateState,
    privateState.secretKey,
  ],
  // Looks the holder's commitment up in the public members tree and returns its
  // Merkle path. The path stays private; the circuit only discloses the root.
  // Revocation is enforced here, at the witness (client) level: a revoked
  // commitment gets no path, so the honest client cannot build the proof.
  // This is client-side enforcement, not a circuit guarantee — see the
  // revokeCommitment comment in veilid.compact for why the circuit cannot
  // test revocation itself without leaking the commitment.
  findMembershipPath: (
    { privateState, ledger }: WitnessContext<Ledger, VeilIdPrivateState>,
    commitment: Uint8Array,
  ): [VeilIdPrivateState, MerkleTreePath<Uint8Array>] => {
    if (ledger.revoked.member(commitment)) {
      throw new Error("VeilID: this key is revoked");
    }
    const path = ledger.members.findPathForLeaf(commitment);
    if (path === undefined) {
      throw new Error("VeilID: this key is not registered in the pass");
    }
    return [privateState, path];
  },
};
