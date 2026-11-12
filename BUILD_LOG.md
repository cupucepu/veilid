# VeilID — BUILD_LOG (Fase 1: toolchain + contract + tests)

## 2026-11-12 ~00:52–01:05 WITA — Fase 1 complete, all green

### Reference studied
- NightPoll (https://github.com/hycorange/nightpoll): contract
  `nightpoll.compact` (pragma 0.23, `HistoricMerkleTree<10, Bytes<32>>`,
  `memberCommitment` / `voteNullifier` via `persistentHash` with domain tags,
  5 impure circuits, 19 vitest simulator tests), repo layout (contract/,
  witnesses.ts, simulator, vitest.config), package versions (compact-runtime
  0.16.0, midnight-js 4.1.1, vitest ^4.1.0, typescript ^5.9.3, Node >= 24.11).
- docs.midnight.network tutorial page fetch failed with HTTP 429 (2026-11-12
  00:53 WITA) — not retried. Install steps below were verified empirically
  against the official `midnightntwrk/compact` GitHub releases instead.

### Toolchain (persistent, under ~/workspace — survives VM replacement)
- Manager: `~/workspace/tools/compact/bin/compact`, version **0.5.3**
  (tarball `compact-x86_64-unknown-linux-musl.tar.xz` from release
  `compact-v0.5.3`; installer script also saved at
  `~/workspace/tools/compact/compact-installer.sh`).
- Toolchain: **compactc 0.31.1** (language 0.23.0, ledger 8.0.2, runtime
  0.16.0) at
  `~/workspace/tools/compact/toolchains/versions/0.31.1/x86_64-unknown-linux-musl/`
  (`COMPACT_DIRECTORY=~/workspace/tools/compact/toolchains`).
- **Blocker found + worked around:** `compact update 0.31.1` fails in this VM —
  the manager's GitHub API client (octocrab) errors with
  `dns error: failed to lookup address information` (2 attempts, ~60 s each),
  while `curl` to api.github.com works fine. Same failure for `compact list`.
  Workaround: downloaded `compactc_v0.31.1_x86_64-unknown-linux-musl.zip`
  directly with curl and extracted it into the manager's expected layout
  `versions/0.31.1/<target-triple>/`. Verified: `compact compile +0.31.1 --help`
  finds the toolchain and prints compactc help. The zip is kept at
  `~/workspace/tools/compact/compactc_v0.31.1_x86_64-unknown-linux-musl.zip`
  for re-installs.
- `scripts/env.sh` exports the persistent PATH + COMPACT_DIRECTORY.

### Repo scaffolded (no GitHub push, no AKINDO registration, no on-chain tx)
- `~/workspace/goals/veilid-midnight-buildathon-wave-3-submission/veilid/`
- LICENSE (Apache-2.0, fetched from NightPoll repo), README.md, .gitignore,
  package.json (workspace root), contract/package.json, tsconfigs,
  vitest.config.ts, scripts/env.sh.

### Contract — contract/src/veilid.compact (compiles, ZK keys generated)
- Pragma language_version 0.23, `import CompactStandardLibrary`.
- 7 impure circuits: register, registerCommitment (admin), revokeCommitment
  (admin), openClaiming (admin), closePass (admin), proveEligible, claim.
- 4 pure circuits: adminKey, memberCommitment ("veilid:member:"),
  claimNullifier ("veilid:nullifier:"), auditFingerprint ("veilid:audit:",
  Vector<4, Bytes<32>> — salted hash of passId + nullifier + salt).
- Ledger: sealed passId / passName / openRegistration / admin; phase
  (REGISTRATION → CLAIMING → CLOSED); members HistoricMerkleTree<10>;
  commitments / revoked / nullifiers sets; memberCount / claimCount /
  eligibleProofs counters.
- Compile: `compact compile +0.31.1 src/veilid.compact ./src/managed/veilid`
  → "Compiling 7 circuits", exit 0, ~48 s. Managed artifacts + prover/verifier
  keys under `contract/src/managed/veilid/` (gitignored, regenerable).
- **Compile failure #1 (fixed):** first version put
  `assert(!revoked.member(commitment))` inside proveEligible/claim and used
  the raw `commitment` parameter in revokeCommitment's ledger ops. compactc
  rejected all three: "potential witness-value disclosure must be declared".
  Root cause: Compact ledger ops on a witness-derived value require
  disclose(), and disclosing the commitment inside claim() would publish it
  in the same tx as the nullifier, linking claim ↔ registration.
  Fix: (a) revokeCommitment discloses its parameter first (admin-side, the
  commitment is already public) — compiles; (b) in-circuit revocation check
  REMOVED from proveEligible/claim; enforcement moved to the witness
  (`witnesses.ts` findMembershipPath throws "VeilID: this key is revoked").
  This is client-side enforcement, NOT a circuit guarantee — documented in
  the contract comments, README "Honest limits", and below. Circuit-level
  private revocation (ZK non-membership / accumulator) is a Fase 2 research
  item; the on-chain revocation set is the hook for it.
  Note: proveEligible's public effect is `eligibleProofs += 1` (the ZK proof
  itself is the boolean attestation); no literal boolean ledger field, since
  it would carry no information beyond the counter.

### Tests — contract/src/test/ (vitest, simulator, no network)
- Files: veilid-simulator.ts (VeilIdSimulator, mirrors NightPoll's), utils.ts,
  veilid.test.ts.
- **22 / 22 pass** (`npm test`, ~3.3 s), run twice (01:01:30 and 01:01:40 WITA).
  Coverage: setup (2), registration (5), phases (1), eligibility (5),
  claiming (4), revocation (3), unlinkability (2).
- `npm run typecheck` (tsc --noEmit): exit 0.
- **Install quirk:** plain `npm install` fails on bundled npm 10.9.4 with
  `TypeError: Cannot read properties of null (reading 'edgesOut')` in arborist
  while resolving vitest 4.x peers. Workaround: `npm install
  --legacy-peer-deps` — works (52 packages, compact-runtime 0.16.0). Recorded
  in README. package-lock.json committed in repo.

### Reproduce
```
source scripts/env.sh
npm install --legacy-peer-deps
npm run compact && npm run typecheck && npm test
```

### NOT done in Fase 1 (planned later)
- No CLI / UI (Fase 2). No local-network e2e, no Preview deployment, no
  on-chain transaction (Fase 3). No GitHub repo/push, no AKINDO registration
  (needs user's GitHub username + own AKINDO account). No deck / video.
- No secrets, keys, or passwords anywhere in the repo (tests use random
  throwaway secret keys generated per test run).

---

# Fase 2: demo webapp (Vite + TypeScript, simulator mode)

## 2026-11-12 ~01:05–01:15 WITA — Fase 2 complete, all green

### Refactor (forced by UI integration)
- Moved `contract/src/test/veilid-simulator.ts` → `contract/src/simulator.ts`
  (imports updated `../managed` → `./managed`, `../witnesses` → `./witnesses`),
  test import updated to `../simulator.js`, and `contract/src/index.ts` now
  also re-exports `./simulator.js`. Reason: the webapp reuses the simulator
  as a library; a test-only file is not importable as one. No contract or
  test logic changed. Verified after the move: `npm run typecheck` exit 0,
  `npm test` 22/22 green (run twice more in Fase 2, still 22/22).

### Webapp scaffolded — veilid/webapp/ (npm workspace member "veilid-webapp")
- Root `package.json`: workspaces `["contract", "webapp"]`; root scripts
  extended (`dev`, `test` runs contract + webapp, `typecheck` runs both).
- `webapp/package.json`: deps `@midnight-ntwrk/compact-runtime 0.16.0`;
  devDeps vite ^8.3.8, typescript ^5.9.3, vitest ^4.1.0 (vite 8.3.8 was
  already hoisted; `npm install --legacy-peer-deps` added 3 packages).
- `vite.config.ts`: dev port 5173, `server.fs.allow: [".."]` so the demo
  engine can import the contract simulator one level up.
- `index.html` + `src/styles.css` (dark Midnight theme, no framework) +
  `src/main.ts` (UI wiring) + `src/demo.ts` (DemoEngine) +
  `src/demo.test.ts` (4 vitest tests) + `webapp/README.md`
  ("Demo in 5 minutes").

### DemoEngine — src/demo.ts (reuses the simulator, no proof logic reinvented)
- Wraps `VeilIdSimulator` with synthetic personas: Alice (jstark.ai),
  Carol, Dave (eligible members) and Bob (sybil, never registered).
  All keys random per run via `crypto.getRandomValues`; the UI never
  renders a secret key (shows `••••••••`).
- Methods: `createPass()` (curated, `openRegistration: false`),
  `registerMembers()` (admin `registerCommitment` × 3),
  `openClaiming()` / `closePass()`, `proveEligible(id)`, `claim(id)`
  (stores Alice's `{nullifier, salt, fingerprint}` on first claim),
  `discloseToAuditor()`, `verifyAudit(nullifier, salt, fingerprint)`
  (recomputes `auditFingerprintOf` and checks `nullifiers.member`;
  MATCH only if both hold), `snapshot()` (public ledger as plain data),
  `status()`, `reset()` (fresh random keys).
- Every step returns a `StepResult` with the exact contract/witness error
  string on rejection (e.g. `VeilID: already claimed`,
  `VeilID: this key is not registered in the pass`).

### UI — 4 tabs + always-visible panels
- Tabs: Issuer / Alice · jstark.ai / Bob · sybil / Auditor. Buttons enable
  only when their step is reachable (phase-gated).
- “▶ Run full demo” auto-plays all 14 actions with narration into the
  transcript: create → register → open → Alice prove → Alice claim →
  Alice claim again (rejected) → Bob prove (rejected) → Bob claim
  (rejected) → disclose → verify MATCH → tamper salt → verify NO MATCH →
  restore salt → verify MATCH.
- Public ledger panel (live): phase, pass id, Merkle root, member /
  eligible-proof / claim / revoked counts, commitments and nullifiers as
  truncated opaque hashes. “Never leaves the device” panel: secret keys,
  wallets, Agent IDs, Merkle paths, audit salts.

### Verification (all run in Fase 2)
- `npm run typecheck -w veilid-webapp`: exit 0.
- `npm test -w veilid-webapp`: **4 / 4 pass** (full 4-role flow, order
  guards, reset freshness, hex parsing).
- `npm run build -w veilid-webapp`: exit 0, 29 modules, `dist/index.html`
  + JS 112 kB (gzip 24.5 kB) + onchain-runtime WASM 1.4 MB from
  compact-runtime. `dist/` is gitignored (root `.gitignore` already had it).
- `npm run dev` (vite, port 5173): index + `/src/main.ts` + `/src/demo.ts`
  + `/src/styles.css` all HTTP 200; server stopped after verification.
- `vite preview` (port 4173): index 200, JS asset 200, correct title;
  server stopped after verification.
- Full root suite `npm test`: contract **22/22** + webapp **4/4**.
- **Bug fixed during build:** first draft of the register handler in
  `main.ts` computed member commitments from the engine's private key
  store (would have thrown at runtime). Removed; commitments now come
  from the public ledger snapshot only. Also removed the now-unused
  imports (`PERSONAS`, `shortHex`, `hex`) from `main.ts`.

### NOT done in Fase 2 (planned later)
- No real ZK proofs (simulator only), no local-network e2e, no Preview
  deployment, no on-chain transaction (Fase 3). No CLI (the webapp covers
  register / prove / claim / audit-verify). No GitHub repo/push, no AKINDO
  registration (needs user's GitHub username + own AKINDO account).
  No revocation exercised in the UI (contract tests cover it).

## Fase 3 — Preview testnet deployment (in progress, 2026-11-12)

### Ledger-9 migration (done)
- Preview relaunched 2026-11-07 as a new ledger-9 chain; old Preview history
  gone. Ledger-8 stack (compactc 0.31.1, midnight-js 4.1.1, proof-server
  8.1.3) does NOT work on current Preview. Required ledger-9 stack:
  Compact toolchain 0.36.0 (language 0.28.0, runtime 0.21.0), Midnight.js
  5.0.0, Wallet SDK 2.0.0, proof server 9.0.0, indexer 4.4.101,
  testkit-js 5.0.0, Compact.js 3.0.0.
- compactc 0.36.0 downloaded + installed
  (`~/workspace/tools/compact/toolchains/versions/0.36.0/`, verified:
  0.36.0 / language 0.28.0 / ZKIR 3.2.0-rc.2 / runtime 0.21.0).
- `veilid.compact` pragma 0.23 → 0.28; compiles clean with 0.36.0
  (7 circuits, ~23 s); managed artifacts replaced in
  `contract/src/managed/veilid/` (incl. `compiler/contract-manifest.json`,
  runtime 0.21.0).
- `compact-runtime` 0.16.0 → 0.21.0 in `contract/` + `webapp/` package.json;
  `compact` scripts now `+0.36.0`.
- Simulator rewritten async for runtime 0.21.0 (`initialState` returns
  Promise; contexts via `createCircuitContext(...)`; state as `ChargedState`).
  `VeilIdSimulator.create()` is now the constructor; all circuit methods
  return `Promise<Ledger>`. Tests + webapp converted to async/await.
- Verified green after migration: typecheck (contract + webapp) pass,
  contract 22/22, webapp 4/4, webapp build OK (JS 117.67 kB, WASM 1.58 MB).
  Re-verified 2026-11-12 ~01:27 UTC after the CLI work: `npm test` exit 0.

### Proof server 9.0.0 (done, running)
- No docker in the VM; fetched the image layer from Docker Hub like
  NightPoll does. amd64 manifest digest
  `sha256:1dbf40d735869d50fa518f49b7d7514c65746af9bbc27978a65ff1824c6842b3`;
  layer `sha256:e1fadff418dda3dc4e77b9c011f9d43709436dfefd026908949019119271454f`
  (29,657,269 bytes, sha256-verified on download).
- GNU tar fails on the nix store layer (read-only 0555 dirs block file
  creation); extracted with Python tarfile forcing dirs to 0755.
  2,951 files, 99 MB under `~/workspace/tools/proof-server-9.0.0/rootfs/`.
- Runner `~/workspace/tools/proof-server-9.0.0/proof-server.sh` (ld-linux +
  glibc 2.42-51 + libgcc, `--num-workers 1`, PID 13401).
  `GET http://127.0.0.1:6300/health` → `{"status":"ok",...}` (verified
  2026-11-12 01:17 UTC). Keep it running for deploy/demo; stop with
  `kill 13401` when done.

### CLI `veilid/cli/` (done, typechecks, wallet syncs)
- Midnight.js 5.0.0 + testkit-js 5.0.0 + wallet-sdk 2.0.0 + Compact.js
  3.0.0 + effect 3.22.4. Commands: `wallet / faucet / fund / deploy /
  demo / state <address>` (`npm run veilid -w @veilid/cli -- <cmd>`).
- Key v5 API facts (from installed .d.ts, not docs memory):
  `setNetworkId()` gone — `providers.config = { networkId, ttlSeconds }`;
  `deployContract`/`findDeployedContract` take a Compact.js
  `CompiledContract` built as `pipe(CompiledContract.make("veilid",
  Contract), withWitnesses(witnesses),
  withCompiledFileAssets(managedDir))`; private state per role via
  `findDeployedContract({ compiledContract, contractAddress,
  privateStateId, initialPrivateState })`; `callTx.<circuit>(...args)`
  returns finalized data with `public.{txHash, txId, blockHeight,
  blockHash}`; state read via
  `queryContractState(addr).contractState.deserialize({ v9: ContractState
  }).data` → `ledger(...)`; `NodeZkConfigProvider(managedDir)` reads
  keys/zkir + verifies against `compiler/contract-manifest.json`.
- `MidnightWalletProvider.build` logs the master seed in plaintext, so the
  CLI builds via `FluentWalletBuilder.buildWithoutStarting()` +
  `MidnightWalletProvider.withWallet()` and `start(false)` instead.
- **VM egress quirk (fixed):** all egress goes through
  `hatch-egress-proxy:3128`; direct wss fails at TLS ("wrong version
  number"). `cli/src/ws-shim.ts` replaces the global WebSocket with a
  `ws`-based one tunneled through the proxy (HttpsProxyAgent) — installed
  only when a proxy env var is set. Also fixed the indexer WS URL:
  `wss://indexer.preview.midnight.network/api/v4/graphql/ws` (the `/ws`
  suffix is required; without it the upgrade gets HTTP 405).
  Verified: proxied indexer WS gets `connection_ack`; polkadot ApiPromise
  over the shim reports chain "Midnight Preview", version 2.1.101,
  genesis 0x3c096de2… (the one "1000 Normal Closure" seen in an early run
  was transient).
- Wallet created 2026-11-12 ~01:33 UTC, seed at `~/.veilid/preview-seed`
  (chmod 600, outside the repo, never printed/committed). Synced fully
  (shielded + unshielded + dust, protocol Settled) 01:38 UTC.
  - Unshielded: `mn_addr_preview1782fhrcqpwjmca6vr5wwvpjuxz757gfeuv2mcjzncrfqyl50gksqfmxyyt`
  - Dust: `mn_dust_preview1wvpm7ggmwgtef54jpr2hnp69ujkgqs5rvqysaav47tntejetuyss7cavxd3`
  - Balances: empty (0 tNIGHT, 0 DUST).

### BLOCKER — faucet captcha (verified empirically, 2026-11-12 01:39 UTC)
- Faucet API (from the faucet SPA bundle
  `/assets/index-Ccts26He.js`): `POST /api/drips` with headers
  `Content-Type: application/json` + `X-Captcha-Token`, body
  `{recipientAddress, amount}`; fixed drip 1000 tNIGHT; status polled at
  `GET /api/drips/{dripId}`.
- Direct POST without a token → **400 `{"error":"Missing
  X-Captcha-Token header"}`**. (First attempt to `/drips` without the
  `/api` prefix → 404.) Programmatic funding is impossible; only a human
  solving the Cloudflare Turnstile captcha in a browser can fund the
  wallet.
- **User step:** open https://faucet.preview.midnight.network, solve the
  captcha, paste
  `mn_addr_preview1782fhrcqpwjmca6vr5wwvpjuxz757gfeuv2mcjzncrfqyl50gksqfmxyyt`.
  One drip (1000 tNIGHT) covers deploy + ~10 demo calls; DUST registers
  automatically on the first transaction.
- Resume after funding: `npm run veilid -- fund` (verify balance + dust),
  then `npm run veilid -- demo` (full 4-role e2e: deploy, register Alice /
  Carol / Dave, open claiming, Alice prove + claim, 2nd claim rejected,
  Bob prove/claim rejected, auditor MATCH + tampered NO MATCH, close pass,
  final state → overwrites `deployments/preview.json` with the real record).
- `deployments/preview.json` currently records the blocker + wallet
  addresses (status `blocked-awaiting-faucet`); no contract deployed yet,
  no tx hashes yet — nothing fabricated.

### NOT done in Fase 3 (waiting on the faucet)
- No deploy, no on-chain demo, no tx hashes, no final on-chain state.
- No GitHub push, no AKINDO action (per Fase 3 constraints; repo
  https://github.com/cupucepu/veilid was created separately by the parent
  agent 2026-11-12 09:37 WITA — username cupucepu, verified 09:33 WITA).
