// pump.js — pump.fun: launch coin, buy, sell, claim creator fees.
// Ported from grokthedev/pump14 (createV2 flow, 13-char on-chain symbol vs 10-char IPFS gotcha).
import fs from "node:fs";
import path from "node:path";
import BN from "bn.js";
import { createRequire } from "node:module";
import {
  Keypair, PublicKey, LAMPORTS_PER_SOL, ComputeBudgetProgram,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
// Load pump-sdk via CJS: its ESM build re-exports agent-payments-sdk, whose
// prebuilt ESM does `import { BN } from "@coral-xyz/anchor"` — anchor 0.31's CJS
// doesn't surface BN as a detectable named ESM export, so the ESM path throws on
// import. The CJS build resolves it fine.
const require = createRequire(import.meta.url);
const {
  PumpSdk, OnlinePumpSdk, newBondingCurve,
  getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount,
} = require("@pump-fun/pump-sdk");
import { connection, wallet } from "./wallet.js";
import { state, pushEvent, save } from "./state.js";

const LIVE = process.env.LIVE === "true";
const ONCHAIN_SYMBOL_MAX = 13;
const IPFS_SYMBOL_MAX = 10;
// funded public wallet for keyless dry-run simulation
const SIM_WALLET = new PublicKey("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");

const sdk = new PumpSdk();
const online = new OnlinePumpSdk(connection);

async function uploadMetadata({ name, symbol, description, imagePath, twitter, website }) {
  const tryUpload = async (sym) => {
    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(imagePath)]), path.basename(imagePath));
    form.append("name", name);
    form.append("symbol", sym);
    form.append("description", description || "");
    if (twitter) form.append("twitter", twitter);
    if (website) form.append("website", website);
    form.append("showName", "true");
    const res = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: form });
    if (!res.ok) throw new Error(`ipfs upload ${res.status}`);
    return (await res.json()).metadataUri;
  };
  try { return await tryUpload(symbol); }
  catch { return await tryUpload(symbol.slice(0, IPFS_SYMBOL_MAX)); }
}

async function sendV0(instructions, signers) {
  const payerKey = wallet ? wallet.publicKey : SIM_WALLET;
  const cu = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
  ];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey, recentBlockhash: blockhash, instructions: [...cu, ...instructions] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);

  if (!LIVE || !wallet) {
    tx.signatures = tx.signatures.map(() => new Uint8Array(64));
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    if (sim.value.err) throw new Error(`dry-run sim failed: ${JSON.stringify(sim.value.err)}`);
    return { sig: "DRY_RUN", dryRun: true };
  }
  tx.sign(signers);
  const sim = await connection.simulateTransaction(tx, { commitment: "confirmed" });
  if (sim.value.err) throw new Error(`sim failed: ${JSON.stringify(sim.value.err)} ${JSON.stringify(sim.value.logs?.slice(-5))}`);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return { sig, dryRun: false };
}

export async function launchCoin({ name, symbol, description, imagePath, twitter, website, devBuySol = 0 }) {
  symbol = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, ONCHAIN_SYMBOL_MAX);
  if (!name || symbol.length < 2) throw new Error("bad name/symbol");
  if (state.coin) throw new Error(`already launched ${state.coin.mint} — one coin per bot`);

  const uri = await uploadMetadata({ name, symbol, description, imagePath, twitter, website });
  const mint = Keypair.generate();
  const payer = wallet ? wallet.publicKey : SIM_WALLET;

  let instructions;
  if (devBuySol > 0) {
    const global = await online.fetchGlobal();
    const feeConfig = await online.fetchFeeConfig();
    const solAmount = new BN(Math.round(devBuySol * LAMPORTS_PER_SOL));
    const amount = getBuyTokenAmountFromSolAmount({
      global, feeConfig, mintSupply: null,
      bondingCurve: newBondingCurve(global),
      amount: solAmount, quoteMint: PublicKey.default,
    });
    instructions = await sdk.createV2AndBuyInstructions({
      global, mint: mint.publicKey, name, symbol, uri,
      creator: payer, user: payer, amount, solAmount, mayhemMode: false,
    });
  } else {
    instructions = [await sdk.createV2Instruction({
      mint: mint.publicKey, name, symbol, uri, creator: payer, user: payer, mayhemMode: false,
    })];
  }

  const { sig, dryRun } = await sendV0(instructions, wallet ? [wallet, mint] : []);
  const coin = { mint: mint.publicKey.toBase58(), name, symbol, sig, dryRun, ts: Date.now(), url: `https://pump.fun/coin/${mint.publicKey.toBase58()}` };
  if (!dryRun) { state.coin = coin; save(); }
  pushEvent("deploy", `${dryRun ? "[DRY RUN] " : ""}launched ${name} ($${symbol}) → ${coin.url}`, { coin });
  return coin;
}

export async function buyToken(mintBase58, sol) {
  if (!wallet) throw new Error("no wallet (demo mode)");
  const mint = new PublicKey(mintBase58);
  const user = wallet.publicKey;
  const global = await online.fetchGlobal();
  const feeConfig = await online.fetchFeeConfig();
  const bs = await online.fetchBuyState(mint, user);
  const solAmount = new BN(Math.round(sol * LAMPORTS_PER_SOL));
  const amount = getBuyTokenAmountFromSolAmount({
    global, feeConfig, mintSupply: bs.bondingCurve.tokenTotalSupply,
    bondingCurve: bs.bondingCurve, amount: solAmount, quoteMint: PublicKey.default,
  });
  const instructions = await sdk.buyInstructions({
    global, bondingCurveAccountInfo: bs.bondingCurveAccountInfo, bondingCurve: bs.bondingCurve,
    associatedUserAccountInfo: bs.associatedUserAccountInfo,
    mint, user, solAmount, amount, slippage: 5,
  });
  return await sendV0(instructions, [wallet]);
}

export async function sellToken(mintBase58, tokenAmountRaw) {
  if (!wallet) throw new Error("no wallet (demo mode)");
  const mint = new PublicKey(mintBase58);
  const user = wallet.publicKey;
  const global = await online.fetchGlobal();
  const feeConfig = await online.fetchFeeConfig();
  const ss = await online.fetchSellState(mint, user);
  const amount = new BN(String(tokenAmountRaw));
  const solAmount = getSellSolAmountFromTokenAmount({
    global, feeConfig, mintSupply: ss.bondingCurve.tokenTotalSupply,
    bondingCurve: ss.bondingCurve, amount, quoteMint: PublicKey.default,
  });
  const instructions = await sdk.sellInstructions({
    global, bondingCurveAccountInfo: ss.bondingCurveAccountInfo, bondingCurve: ss.bondingCurve,
    mint, user, amount, solAmount, slippage: 5,
  });
  return await sendV0(instructions, [wallet]);
}

// Creator fees: vault balance across both programs (bonding curve + AMM), then collect.
export async function creatorFeeBalance() {
  if (!wallet) return 0;
  try {
    const lamports = await online.getCreatorVaultBalanceBothPrograms(wallet.publicKey);
    return Number(lamports) / LAMPORTS_PER_SOL;
  } catch (e) { pushEvent("error", `creatorFeeBalance: ${e.message}`); return 0; }
}

export async function claimCreatorFees() {
  if (!wallet) throw new Error("no wallet (demo mode)");
  const instructions = await online.collectCoinCreatorFeeInstructions(wallet.publicKey);
  if (!instructions?.length) return { sig: null, claimed: 0 };
  const before = await creatorFeeBalance();
  const { sig, dryRun } = await sendV0(instructions, [wallet]);
  state.lastClaimAt = Date.now(); save();
  pushEvent("info", `${dryRun ? "[DRY RUN] " : ""}claimed ~${before.toFixed(4)} SOL creator fees (${sig})`);
  return { sig, claimed: before, dryRun };
}
