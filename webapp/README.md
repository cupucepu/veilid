# 🌙 VeilID demo webapp

Simulator-mode demo UI for the VeilID Private Agent Pass. A judge can run
the whole 4-role demo in ~5 minutes with **no wallet and no network** — the
circuits run against a local simulated ledger using the real compiled
contract (`contract/src/veilid.compact` + managed artifacts), the same code
path as the 22 contract tests.

## Demo in 5 minutes

```sh
# from the repo root (veilid/)
source scripts/env.sh
npm install --legacy-peer-deps   # once; plain npm install hits a known arborist bug, see main README
npm run dev                      # or: cd webapp && npm run dev
# open http://localhost:5173 — press "▶ Run full demo"
```

What the auto-run does, step by step:

1. **Issuer** — creates “VeilID Agent Pass #1”, registers 3 members
   (Alice, Carol, Dave) by commitment only, opens claiming.
2. **Alice (jstark.ai)** — proves eligible: the UI shows only
   `eligible: true` and the public `eligibleProofs` counter +1. Her secret
   key, wallet and commitment are never displayed. Then she claims once —
   success, the nullifier appears on the public ledger. She claims again —
   rejected with the contract's exact error (`VeilID: already claimed`).
3. **Bob (sybil)** — never registered. Prove eligible: rejected
   (`VeilID: this key is not registered in the pass`). Claim: rejected.
4. **Auditor** — Alice voluntarily discloses one claim (nullifier + salt).
   Verify → green **MATCH**: the recomputed audit fingerprint equals the
   disclosed one and the nullifier is on chain. Then the demo tampers with
   one salt digit → **NO MATCH**. Restoring the salt → MATCH again.

Every step can also be clicked manually, tab by tab. **↺ New demo run**
regenerates all secret keys, so each run has fresh synthetic data.

The **Public ledger** panel (right column) is always visible: phase,
member count, eligible proofs, claim count, commitments and nullifiers as
opaque hashes only. The **Never leaves the device** panel lists what stays
private: secret keys, wallets, Agent IDs, Merkle paths, audit salts.

## Files

- `src/demo.ts` — `DemoEngine`: wraps the contract simulator
  (`../contract/src/simulator.ts`, reused — no proof logic reinvented).
  All demo data is synthetic and random per run (`crypto.getRandomValues`).
- `src/main.ts` — UI wiring (tabs, buttons, ledger panel, transcript).
- `src/demo.test.ts` — 4 vitest tests driving the exact flow the UI runs.
- `index.html`, `src/styles.css` — dark Midnight theme, no framework.

## Commands

```sh
npm run dev        # Vite dev server on http://localhost:5173
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build (http://localhost:4173)
npm test           # 4 demo-engine tests (vitest)
```

## Honest limits

- **Simulator proofs, not real proofs (yet).** Circuits run locally without
  generating ZK proofs. Real proofs on a local network / Preview testnet
  are Fase 3.
- **Revocation is witness-enforced**, not circuit-enforced (see the main
  README's “Honest limits”). The demo does not exercise revocation; the
  contract tests do.
- The bundled `dist/` is gitignored; the WASM asset in the production
  build (`midnight_onchain_runtime_wasm_bg-*.wasm`, ~1.4 MB) comes from
  `@midnight-ntwrk/compact-runtime`.
