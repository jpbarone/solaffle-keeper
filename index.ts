/**
 * Solaffle keeper — Node runtime (VRF draws + prize delivery)
 * ===========================================================
 *
 * Same on-chain logic as the (Deno) edge function, but packaged for a Node host
 * because the Switchboard + anchor bundle is too heavy for the Supabase edge
 * bundler. This is the environment scripts/vrf_draw_test.ts already runs in.
 *
 * Two run modes:
 *   npm start          -> long-running loop (every KEEPER_INTERVAL_MS, default 60s)
 *                         for an always-on host (Railway / Render / Fly).
 *   npm run once       -> a single pass, then exit — for GitHub Actions / cron.
 *
 * Env vars (host secrets — NEVER commit these):
 *   RPC_URL             a devnet/mainnet RPC (Helius etc.)
 *   KEEPER_SECRET       JSON secret-key array for the low-privilege keeper wallet
 *   IDL_PATH            optional; defaults to ./solotto_raffle.json
 *   KEEPER_INTERVAL_MS  optional loop interval (default 60000)
 *
 * The draw + delivery are PERMISSIONLESS on-chain, so the keeper only pays gas
 * (+ tiny randomness-account rent) and can never redirect prize funds.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as sb from "@switchboard-xyz/on-demand";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// ── tuning ──────────────────────────────────────────────────────────────────
const MAX_DRAWS_PER_RUN = 2; // bound a single pass's wall-clock time
const ORACLE_WAIT_MS = 4000; // let the oracle produce the value before reveal
const REVEAL_TRIES = 6; // reveal retries (oracle can lag)
const REVEAL_DELAY_MS = 3000;
const CU_PRICE = 75_000;
const CU_MULT = 1.3;

const kindOf = (r: any) => Object.keys(r.prizeKind)[0]; // "offChain" | "sol" | "token"
const statusOf = (r: any) => Object.keys(r.status)[0]; // "open" | "drawing" | "completed" | "refunding"
const n = (v: any) => (typeof v === "number" ? v : Number(v.toString()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retry a flaky network/RPC call a few times before giving up. Transient RPC
// errors (504s, rate limits) are common on shared endpoints — one blip should
// not crash the whole run.
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  tries = 4,
  delayMs = 2500
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < tries) {
        console.warn(`${label} attempt ${i}/${tries} failed: ${(e as Error).message} — retrying in ${delayMs}ms`);
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}

function loadEnv() {
  const RPC_URL = process.env.RPC_URL;
  const KEEPER_SECRET = process.env.KEEPER_SECRET;
  if (!RPC_URL) throw new Error("RPC_URL env var is required");
  if (!KEEPER_SECRET) throw new Error("KEEPER_SECRET env var is required");
  const idlPath = process.env.IDL_PATH || path.join(process.cwd(), "solotto_raffle.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(KEEPER_SECRET)));
  return { RPC_URL, keeper, idl };
}

// Build a Switchboard v0 tx, sign with the given signers, send + confirm.
async function sendIxs(
  conn: Connection,
  ixs: any[],
  payer: Keypair,
  signers: Keypair[]
): Promise<string> {
  const tx: VersionedTransaction = await sb.asV0Tx({
    connection: conn,
    ixs,
    payer: payer.publicKey,
    signers,
    computeUnitPrice: CU_PRICE,
    computeUnitLimitMultiple: CU_MULT,
  });
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

// reveal + settle_draw for a raffle whose committed randomness account we know.
async function revealAndSettle(
  conn: Connection,
  program: any,
  sbProgram: any,
  keeper: Keypair,
  rafflePk: PublicKey,
  randomnessPk: PublicKey,
  payoutRecipient: PublicKey,
  feeRecipient: PublicKey
): Promise<string> {
  const randomness = new sb.Randomness(sbProgram, randomnessPk);
  let lastErr: unknown;
  for (let i = 1; i <= REVEAL_TRIES; i++) {
    try {
      const revealIx = await randomness.revealIx(keeper.publicKey);
      const settleIx = await program.methods
        .settleDraw()
        .accounts({
          raffle: rafflePk,
          randomnessAccountData: randomnessPk,
          payoutRecipient,
          feeRecipient,
        })
        .instruction();
      return await sendIxs(conn, [revealIx, settleIx], keeper, [keeper]);
    } catch (e) {
      lastErr = e;
      if (i < REVEAL_TRIES) await sleep(REVEAL_DELAY_MS);
    }
  }
  throw lastErr;
}

// Full inline VRF draw for a newly-endable, above-floor raffle.
async function vrfDraw(
  conn: Connection,
  program: any,
  sbProgram: any,
  queue: PublicKey,
  keeper: Keypair,
  rafflePk: PublicKey,
  r: any
): Promise<string> {
  const rngKp = Keypair.generate();
  const [randomness, createIx] = await sb.Randomness.create(
    sbProgram,
    rngKp,
    queue,
    keeper.publicKey
  );
  await sendIxs(conn, [createIx], keeper, [keeper, rngKp]);

  const commitIx = await randomness.commitIx(queue, keeper.publicKey);
  const requestIx = await program.methods
    .requestDraw()
    .accounts({ raffle: rafflePk, randomnessAccountData: rngKp.publicKey })
    .instruction();
  await sendIxs(conn, [commitIx, requestIx], keeper, [keeper]);

  await sleep(ORACLE_WAIT_MS);
  return revealAndSettle(
    conn,
    program,
    sbProgram,
    keeper,
    rafflePk,
    rngKp.publicKey,
    r.payoutRecipient,
    r.feeRecipient
  );
}

export async function runKeeper() {
  const { RPC_URL, keeper, idl } = loadEnv();
  const conn = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(keeper), {
    commitment: "confirmed",
  });
  const program: any = new anchor.Program(idl as anchor.Idl, provider);

  const sbProgram = await withRetry("load switchboard program", () =>
    sb.AnchorUtils.loadProgramFromConnection(conn)
  );
  const queue = (
    await withRetry("load switchboard queue", () => sb.Queue.loadDefault(sbProgram))
  ).pubkey;

  const now = Math.floor(Date.now() / 1000);
  const raffles = (await withRetry("fetch all raffles", () =>
    program.account.raffle.all()
  )) as any[];
  let drew = 0,
    settledStuck = 0,
    refunded = 0,
    delivered = 0,
    reclaimed = 0;
  const errors: string[] = [];
  let drawsThisRun = 0;

  // ── PASS 1: recover raffles already mid-draw (committed but not settled) ──
  for (const it of raffles) {
    const r = it.account;
    if (statusOf(r) !== "drawing") continue;
    const randomnessPk = r.randomnessAccount as PublicKey;
    if (!randomnessPk || randomnessPk.equals(PublicKey.default)) continue;
    try {
      await revealAndSettle(
        conn,
        program,
        sbProgram,
        keeper,
        it.publicKey,
        randomnessPk,
        r.payoutRecipient,
        r.feeRecipient
      );
      settledStuck++;
    } catch (e) {
      errors.push(`stuck-draw raffle ${n(r.id)}: ${(e as Error).message}`);
    }
  }

  // ── PASS 2: draw / refund newly-endable raffles ──
  for (const it of raffles) {
    const r = it.account;
    const rafflePk = it.publicKey;
    const status = statusOf(r);
    const endable =
      n(r.ticketsSold) >= n(r.maxTickets) || now >= n(r.endTimestamp);
    if (status !== "open" || !endable) continue;

    if (n(r.ticketsSold) < n(r.minTickets)) {
      try {
        await program.methods
          .requestDraw()
          .accounts({ raffle: rafflePk, randomnessAccountData: queue })
          .rpc();
        refunded++;
      } catch (e) {
        errors.push(`refund-flip raffle ${n(r.id)}: ${(e as Error).message}`);
      }
      continue;
    }

    if (drawsThisRun >= MAX_DRAWS_PER_RUN) continue;
    drawsThisRun++;
    try {
      await vrfDraw(conn, program, sbProgram, queue, keeper, rafflePk, r);
      drew++;
    } catch (e) {
      errors.push(`vrf-draw raffle ${n(r.id)}: ${(e as Error).message}`);
    }
  }

  // ── PASS 3: deliver prizes on completed raffles ──
  for (const it of raffles) {
    const r = it.account;
    const rafflePk = it.publicKey;
    if (!(r.prizeFunded && !r.prizeDelivered)) continue;
    let fresh: any;
    try {
      fresh = await withRetry("refetch raffle", () =>
        program.account.raffle.fetch(rafflePk)
      );
    } catch (e) {
      errors.push(`deliver-fetch raffle ${n(r.id)}: ${(e as Error).message}`);
      continue;
    }
    if (statusOf(fresh) !== "completed" || fresh.prizeDelivered) continue;
    const kind = kindOf(fresh);
    try {
      if (kind === "sol") {
        await program.methods
          .deliverPrize()
          .accounts({ raffle: rafflePk, winnerAccount: fresh.winner })
          .rpc();
        delivered++;
      } else if (kind === "token") {
        const mint = fresh.prizeMint as PublicKey;
        const escrowAta = getAssociatedTokenAddressSync(mint, rafflePk, true);
        const winnerAta = getAssociatedTokenAddressSync(mint, fresh.winner);
        await program.methods
          .deliverPrizeToken()
          .accounts({
            raffle: rafflePk,
            payer: keeper.publicKey,
            prizeMint: mint,
            escrowToken: escrowAta,
            winner: fresh.winner,
            winnerToken: winnerAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        delivered++;
      }
      // offChain (physical) prizes are fulfilled manually via the admin console.
    } catch (e) {
      errors.push(`deliver raffle ${n(r.id)}: ${(e as Error).message}`);
    }
  }

  // ── PASS 4: reclaim operator SOL from failed raffles (permissionless) ──
  for (const it of raffles) {
    const r = it.account;
    const rafflePk = it.publicKey;
    if (
      statusOf(r) === "refunding" &&
      kindOf(r) === "sol" &&
      r.prizeFunded &&
      !r.prizeDelivered
    ) {
      try {
        await program.methods
          .reclaimPrize()
          .accounts({ raffle: rafflePk, authority: r.authority })
          .rpc();
        reclaimed++;
      } catch (e) {
        errors.push(`reclaim raffle ${n(r.id)}: ${(e as Error).message}`);
      }
    }
  }

  const result = {
    ts: new Date().toISOString(),
    scanned: raffles.length,
    drew,
    settledStuck,
    refunded,
    delivered,
    reclaimed,
    errors,
  };
  console.log(JSON.stringify(result));
  return result;
}

// ── runner ───────────────────────────────────────────────────────────────────
async function main() {
  const once = process.argv.includes("--once") || process.env.RUN_ONCE === "1";
  if (once) {
    await runKeeper();
    return;
  }
  const interval = Number(process.env.KEEPER_INTERVAL_MS || 60_000);
  console.log(`keeper loop started (every ${interval}ms)`);
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap runs
    running = true;
    try {
      await runKeeper();
    } catch (e) {
      console.error("keeper run failed:", (e as Error).message);
    } finally {
      running = false;
    }
  };
  await tick();
  setInterval(tick, interval);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
