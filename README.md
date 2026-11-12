# 🌙 VeilID — Private Agent Pass

**Prove you hold a .ai Agent ID without revealing your wallet.**

VeilID is a privacy-first pass for AI-agent operators. An issuer (a project, a
tournament, a collab) publishes the set of eligible holders as opaque hashes.
A holder proves in zero knowledge that they are eligible — and claims the
pass exactly once — without revealing their wallet address, their Agent ID,
or which token made them eligible. The chain only ever sees commitments,
nullifiers, and counts.

Built for the **Midnight Buildathon (AKINDO), Wave 3**, by **cupucepu**
(Agent ID **jstark.ai**).
License: Apache-2.0.

|  |  |
| --- | --- |
| Contract | `contract/src/veilid.compact` (Compact 0.36.0, language 0.28.0, ledger 9, runtime 0.21.0) |
| Circuits | 11 exported circuits (7 impure + 4 pure), compiles with ZK keys (`npm run compact`, ~48 s) |
| Tests | 22 / 22 contract simulator tests + 4 / 4 webapp engine tests (26 total, `npm test`) |
| Deployment | Preview testnet deployment pending — Fase 3 in progress (`cli/` deploy tooling, no on-chain tx yet) |
| Reference pattern | NightPoll (Merkle membership + commitment + nullifier), adapted — not copied |

## For judges: verify in ~10 minutes

```
git clone https://github.com/cupucepu/veilid.git && cd veilid
source scripts/env.sh && npm install --legacy-peer-deps
npm run compact && npm run typecheck && npm test   # technical gate: contract compiles, 26 tests pass
npm run dev                                        # demo webapp on http://localhost:5173 — press "▶ Run full demo"
```

> `npm install` needs `--legacy-peer-deps` with the bundled npm 10.9.4: plain
> `npm install` hits a known arborist bug (`Cannot read properties of null
> (reading 'edgesOut')`) while resolving vitest 4.x peer dependencies.

## Why this needs ZK

Today, every free mint, whitelist, collab or tournament check for Agent ID
holders works the same way: paste your wallet. One paste exposes everything
— all 200 NFTs, balances, history — linkable forever, and a magnet for
phishing, front-running and sybil farming. The alternative, anonymous forms,
can't stop one person claiming ten times.

VeilID gets both properties at once:

1. **Eligibility without identity.** A holder proves *"my secret key belongs
   to one of the registered commitments"* with a Merkle-membership proof.
   The proof doesn't say which commitment, which wallet, or which Agent ID.
2. **One holder, one claim, still anonymous.** Each claim publishes
   `nullifier = H("veilid:nullifier:", passId, sk)`. A second claim from the
   same key produces the same nullifier and is rejected. Commitments and
   nullifiers use different domain tags, so nobody can link a claim back to
   a registration.
3. **Voluntary audit.** A holder can disclose exactly one claim to an
   auditor via `auditFingerprint = H("veilid:audit:", passId, nullifier, salt)`.
   The auditor recomputes it from the disclosed `(nullifier, salt)` and
   checks it against the on-chain nullifier set — without learning the
   wallet, the secret key, or the commitment.
4. **Revocation without doxxing.** The issuer can revoke a commitment
   (Agent ID sold, abuse). See *Honest limits* for how far this goes in
   Fase 1.

Midnight fits this well. The contract logic runs locally over **private
state** (the holder's secret key never leaves their device), and the chain
verifies a ZK proof of that run. Only the values the contract explicitly
`disclose()`s reach the **public ledger**. That's Midnight's dual-ledger
model.

## How it works

```
holder device (private)                        Midnight public ledger
───────────────────────                        ──────────────────────
sk  (never shared)
 │
 ├─ register():  c = H(member, passId, sk) ──►  members MerkleTree += c
 │      (or admin registerCommitment(c); holder hands c over off-chain)     commitments += c
 │
 ├─ proveEligible(): witness: Merkle path for c
 │               proves: path.leaf == H(member, passId, sk)
 │                       root(path) ∈ members history
 │               discloses: nothing identifying ─►  eligibleProofs += 1
 │
 ├─ claim():     same membership proof
 │               discloses: nul = H(nullifier, passId, sk)
 │                          ────────────────────►  nullifiers += nul (must be new)
 │                                                 claimCount += 1
 │
 └─ auditFingerprint(passId, nul, salt): holder discloses (nul, salt) to
    an auditor off-chain; auditor recomputes H(audit, passId, nul, salt)
    and checks nul ∈ nullifiers on chain. Nothing else is revealed.

admin (key-derived, H(admin, passId, sk_admin))  openClaiming() / closePass() /
                                                 revokeCommitment(c): REGISTRATION → CLAIMING → CLOSED
```

| Public (on chain) | Private (stays on the device) |
| --- | --- |
| pass id, pass name, phase, admin key hash | each holder's secret key |
| member commitments (opaque hashes), member count | which commitment belongs to which person |
| nullifiers (opaque, unlinkable to commitments) | which holder made which claim |
| revocation set (opaque commitments) | the Merkle path used in each proof |
| eligibleProofs / claimCount counters | the audit salt (until voluntarily disclosed) |

### Contract (`contract/src/veilid.compact`)

- Ledger: sealed `passId`, `passName`, `openRegistration`, `admin`. Plus
  `phase`, `members: HistoricMerkleTree<10, Bytes<32>>` (up to 1024 members),
  `commitments: Set`, `revoked: Set`, `nullifiers: Set`, `memberCount`,
  `claimCount`, `eligibleProofs`.
- Impure circuits (7):
  - `register()`: self-registration, only when `openRegistration` is on.
  - `registerCommitment(commitment)`: admin only, for curated passes.
  - `revokeCommitment(commitment)`: admin only, publishes a revocation.
  - `openClaiming()` / `closePass()`: admin-only phase changes.
  - `proveEligible()`: membership proof, only public effect is `eligibleProofs += 1`.
  - `claim()`: membership proof + fresh nullifier, `claimCount += 1`.
- Pure circuits (4): `adminKey`, `memberCommitment`, `claimNullifier`,
  `auditFingerprint` — all domain-separated `persistentHash`es.
- Witnesses (`contract/src/witnesses.ts`): `localSecretKey()` and
  `findMembershipPath(c)`. The circuit re-checks everything they return, so
  a malicious witness can't forge membership. Tests cover a path taken from
  another tree and a path borrowed from another member.
- `HistoricMerkleTree` lets a proof against a slightly older root still
  verify while new members join.

### Repo layout

```
contract/   Compact contract, witnesses, simulator + 22 vitest tests
webapp/     Vite + TypeScript demo UI (simulator mode, no wallet, no network)
cli/        Preview testnet deploy CLI (Midnight.js 5, ledger 9) — Fase 3
scripts/    env.sh (Node 24 + compact on PATH, persistent under ~/workspace)
```

Fase 2 (done, 2026-11-12): Vite + TypeScript demo webapp in `webapp/`
(simulator mode, no wallet, no network) — 4-role demo (issuer / Alice /
Bob / auditor), live public-ledger + private panels, 4 engine tests.
`npm run dev` → http://localhost:5173, press “▶ Run full demo”.
## Preview deployment

Fase 3 (in progress): `cli/` deploys to Midnight Preview testnet (ledger 9)
with real ZK proofs — Midnight.js 5.0.0, proof server 9.0.0 (running
locally, `http://127.0.0.1:6300/health` ok), Compact.js 3.0.0. Full
4-role end-to-end demo: `npm run veilid -- demo` (see `cli/src/demo.ts`).

**Status 2026-11-12: funded, DUST registered, demo re-run in progress.**
The deploy wallet is created and synced. Funding came from the Preview
faucet, which requires a Cloudflare Turnstile captcha, so only a human
can fund it:

- Faucet: https://faucet.preview.midnight.network
- Wallet (unshielded): `mn_addr_preview1782fhrcqpwjmca6vr5wwvpjuxz757gfeuv2mcjzncrfqyl50gksqfmxyyt`
- Amount: the faucet dispensed **5,000 tNIGHT** (not 1,000 as first assumed)
- Proof the captcha blocks automation: `POST /api/drips` without a token
  returns `400 {"error":"Missing X-Captcha-Token header"}` (verified
  2026-11-12).

**DUST registration (ledger 9, required).** Transaction fees are paid in
DUST, and holding tNIGHT generates none on its own — the NIGHT UTxOs must
first be registered for DUST generation
(`wallet.registerNightUtxosForDustGeneration`). The first demo run failed
on exactly this (`Wallet.InsufficientFunds: could not balance dust`).
Register explicitly, then wait for DUST to accrue before deploying:

```
npm run veilid -- fund            # verify tNIGHT balance
npm run veilid -- register-dust   # registration tx, then poll until dust > 0
npm run veilid -- demo            # deploy + full 4-role demo (also registers dust first)
```

Registration tx `00b640f1…fa6952a` (fee ≈ 0.36 DUST); DUST was ~82 and
accruing ~3/min at last check. Deployment record:
`deployments/preview.json` (currently `dust-registered`; no contract
deployed yet, no tx hashes yet).

## Quickstart

Prerequisites: Node ≥ 24.11 and the Compact toolchain (manager 0.5.3,
compiler 0.36.0). `scripts/env.sh` puts the persistent installs on `PATH`.

```
source scripts/env.sh
npm install --legacy-peer-deps
npm run compact          # compile contract + ZK keys (~48 s)
npm run typecheck
npm test                 # 22 simulator tests
```

### Install the toolchain (what `scripts/env.sh` points at)

The Compact manager binary lives at `~/workspace/tools/compact/bin/compact`
(manager 0.5.3, from the
[compact-v0.5.3 release](https://github.com/midnightntwrk/compact/releases)).
Its toolchains live under `~/workspace/tools/compact/toolchains`
(`COMPACT_DIRECTORY`), so a VM replacement does not wipe them.

```sh
# manager (0.5.3) — tarball from the compact-v0.5.3 release
curl -sL -o compact.tar.xz \
  https://github.com/midnightntwrk/compact/releases/download/compact-v0.5.3/compact-x86_64-unknown-linux-musl.tar.xz
tar -xJf compact.tar.xz -C ~/workspace/tools/compact/bin --strip-components=1

# toolchain 0.36.0 — normally: compact update 0.36.0
# NOTE (2026-11-12): `compact update` fails in this VM — its GitHub API
# client gets a DNS error while curl to api.github.com works fine. Manual
# install, verified working:
curl -sL -o compactc.zip \
  https://github.com/midnightntwrk/compact/releases/download/compactc-v0.36.0/compactc_v0.36.0_x86_64-unknown-linux-musl.zip
unzip -q compactc.zip -d ~/workspace/tools/compact/toolchains/versions/0.36.0/x86_64-unknown-linux-musl

# verify
compact --version            # compact 0.5.3
compact compile +0.36.0 --help   # prints compactc help (toolchain found)
```

## Tests

`npm test` runs 26 tests — 22 contract simulator tests (local ledger, no
proofs, no network) and 4 webapp engine tests:

- setup: ledger init, determinism
- registration: self-registration publishes only a commitment, duplicate
  rejection, disabled self-registration, admin-only curated registration,
  registration closes when claiming opens
- phases: admin-only open/close, in order
- eligibility: member proves (counter only), rejection before open,
  non-member refused, forged path from another tree rejected, borrowed
  path rejected
- claiming: first claim records the nullifier, second claim rejected,
  claims rejected before open / after close, ledger never contains secret keys
- revocation: admin revokes, revoked member cannot claim or prove (honest
  witness refuses), admin-only + unknown/double-revoke guards, no revoke
  after close
- unlinkability: same key differs across passes; commitment, nullifier and
  audit fingerprint are mutually unlinkable; fingerprint recomputes and
  verifies against the on-chain nullifier after a claim

## Honest limits (read before trusting this)

- **Issuer trust.** The issuer decides who is eligible and publishes the
  commitment set. VeilID proves *membership in the issuer's set* — it does
  not prove the issuer was fair, and it cannot verify off-chain facts (that
  a wallet really owns an Agent ID) by itself. In the demo the eligibility
  set is built from public BSC holdings data, hashed; the raw list is never
  published.
- **Small anonymity set.** Privacy is only as good as the number of
  registered members. With 3 members in a test, a claim is anonymous among
  3, not among thousands. The tree holds up to 1024 members per pass.
- **Revocation is witness-enforced in Fase 1, not circuit-enforced.**
  `revokeCommitment()` publishes the revoked commitment on chain, and the
  honest client (`witnesses.ts`) refuses to build a proof for it. The
  circuit itself does *not* test revocation: Compact's ledger API cannot
  test membership of a witness-derived value without `disclose()`ing it,
  and disclosing the commitment inside `claim()` would publish it in the
  same transaction as the nullifier — linking the claim back to the
  registration and destroying unlinkability. A custom (malicious) client
  could ignore the witness check, so this is not a cryptographic guarantee
  yet. Circuit-level private revocation (ZK non-membership proof /
  accumulator) is a Fase 2 research item; the on-chain revocation set is
  the hook it will build on.
- **Simulator proofs, not real proofs (yet).** Fase 1 tests run circuits
  against a simulated ledger. Real ZK proofs on a local network / Preview
  testnet are Fase 3.
- **No Sybil resistance beyond the issuer.** One person with two secret keys
  can register twice if the issuer lets them. The nullifier stops *double
  claims*, not *double registration* — that is the issuer's job (one
  commitment per verified Agent ID).
- **Metadata still leaks.** Timing, IP, and transaction fees are outside
  this contract's scope.

## Roadmap

- **Fase 1 (done, 2026-11-12):** toolchain + contract + 22 green tests.
- **Fase 2 (done, 2026-11-12):** demo webapp in `webapp/` — 4-role flow
  (issuer / Alice / Bob / auditor), public-ledger + “never leaves the
  device” panels, `npm run dev`, 4 engine tests green.
- **Fase 3 (in progress):** Preview testnet CLI (`cli/`) and end-to-end
  demo with real ZK proofs; deployment record in
  `deployments/preview.json`; then demo video, slide deck, and AKINDO
  submission (deadline 30 Nov 2026, 23:00 WITA).

## License and attribution

Apache-2.0. Reference pattern: NightPoll by hycorange (Merkle membership +
commitment + nullifier on Compact 0.31.1) — adapted for a claim pass with
revocation and audit fingerprints, not copied wholesale.
