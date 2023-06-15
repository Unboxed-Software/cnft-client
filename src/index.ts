import {
  AccountMeta,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js"
import {
  airdropSolIfNeeded,
  getOrCreateKeypair,
  heliusApi,
  createCompressedNFTMetadata,
  extractAssetId,
} from "./utils"
import {
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  ValidDepthSizePair,
  createAllocTreeIx,
  SPL_NOOP_PROGRAM_ID,
  ConcurrentMerkleTreeAccount,
} from "@solana/spl-account-compression"
import {
  PROGRAM_ID as BUBBLEGUM_PROGRAM_ID,
  createCreateTreeInstruction,
  createMintV1Instruction,
  createTransferInstruction,
  createBurnInstruction,
} from "@metaplex-foundation/mpl-bubblegum"

async function main() {
  // Establishing connection to Solana devnet cluster
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed")

  // Getting or creating the first wallet (Wallet_1)
  const wallet = await getOrCreateKeypair("Wallet_1")

  // Getting or creating the second wallet (Wallet_2)
  const wallet2 = await getOrCreateKeypair("Wallet_2")

  // Airdropping devnet Sol to first wallet if needed
  airdropSolIfNeeded(wallet.publicKey)
}

main()
