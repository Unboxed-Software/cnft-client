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

  // Defining the maximum depth and buffer size for the Merkle tree
  const maxDepthSizePair: ValidDepthSizePair = {
    maxDepth: 3,
    maxBufferSize: 8,
  }

  // Defining the canopy depth for the Merkle tree
  const canopyDepth = 0

  // Creating the Merkle tree account
  const treeAddress = await createTree(
    connection,
    wallet,
    maxDepthSizePair,
    canopyDepth
  )

  // Mint one compressed NFT to the first wallet
  const assetId1 = await mintCompressedNFT(connection, wallet, treeAddress)

  // Mint another compressed NFT to the first wallet
  const assetId2 = await mintCompressedNFT(connection, wallet, treeAddress)

  // Transfer the first NFT from Wallet_1 to Wallet_2
  await transferCompressedNFT(connection, assetId1, wallet, wallet2)

  // Burn the second NFT from Wallet_1
  await burnCompressedNFT(connection, assetId2, wallet)
}

// Helper function to create a tree account and initialize it through the MPL Bubblegum program
async function createTree(
  connection: Connection, // The connection to Solana cluster
  payer: Keypair, // The payer of the transaction
  maxDepthSizePair: ValidDepthSizePair, // The maximum depth and buffer size of the tree
  canopyDepth: number // The canopy depth of the tree
) {
  // Generates a new random keypair to use as the address of the tree account
  const treeKeypair = Keypair.generate()

  // Derives the tree authority PDA using the tree account address as a seed
  // This is a PDA derived from the Metaplex Bubblegum program, allowing the program to make changes to the tree account
  // This PDA is also used by the Metaplex Bubblegum program to initialize a "TreeConfig" account

  //   pub struct TreeConfig {
  //     pub tree_creator: Pubkey,
  //     pub tree_delegate: Pubkey,
  //     pub total_mint_capacity: u64,
  //     pub num_minted: u64,
  //     pub is_public: bool,
  // }
  const [treeAuthority, _bump] = PublicKey.findProgramAddressSync(
    [treeKeypair.publicKey.toBuffer()],
    BUBBLEGUM_PROGRAM_ID
  )

  // Instruction to create and allocate space for the tree account by invoking the system program directly.
  // This instruction is created separately from the one initializing the tree account through the MPL Bubblegum program
  // because the account size could exceed the limit that can be initialized through a Cross-Program Invocation (CPI).
  const allocTreeIx = await createAllocTreeIx(
    connection, // The connection to Solana cluster
    treeKeypair.publicKey, // The address of the tree account to create
    payer.publicKey, // The payer of the transaction
    maxDepthSizePair, // The maximum depth and buffer size of the tree
    canopyDepth // The canopy depth of the tree
  )

  // Instruction to initialize `TreeConfig` account and the Merkle tree account
  // The tree account is initialized using a CPI to the SPL Account Compression program from the MPL Bubblegum program
  const createTreeIx = createCreateTreeInstruction(
    {
      treeAuthority, // The tree authority PDA, used to initialize the "TreeConfig" account
      merkleTree: treeKeypair.publicKey, // The address of the tree account to initialize, this account should already exist allocated with the correct space
      payer: payer.publicKey, // The payer of the transaction
      treeCreator: payer.publicKey, // Address set as "tree_creator" in the "TreeConfig" account
      logWrapper: SPL_NOOP_PROGRAM_ID, // The log wrapper program, used to log data and performs no other function
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, // The SPL Account Compression program, used to initialize the tree account
    },
    {
      maxBufferSize: maxDepthSizePair.maxBufferSize, // The maximum buffer size of the tree
      maxDepth: maxDepthSizePair.maxDepth, // The maximum depth of the tree
      public: false, // Whether the tree account is public or not
    },
    BUBBLEGUM_PROGRAM_ID // The program ID of the MPL Bubblegum program
  )

  try {
    // Creates a new transaction and adds the instructions
    const tx = new Transaction().add(allocTreeIx, createTreeIx)
    tx.feePayer = payer.publicKey // Set the payer of the transaction fees

    // Send and confirm the transaction
    const txSignature = await sendAndConfirmTransaction(
      connection,
      tx,
      [treeKeypair, payer], // signers array, the treeKeypair is included because it is used to create the tree account
      {
        commitment: "confirmed",
        skipPreflight: true,
      }
    )

    console.log(`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`)

    console.log("Tree Address:", treeKeypair.publicKey.toBase58())

    return treeKeypair.publicKey
  } catch (err: any) {
    console.error("\nFailed to create merkle tree:", err)
    throw err
  }
}

// Helper function to mint a compressed NFT to a leaf of the Merkle tree account
async function mintCompressedNFT(
  connection: Connection, // The connection to Solana cluster
  payer: Keypair, // The payer of the transaction
  treeAddress: PublicKey // The address of the tree account
) {
  // Compressed NFT Metadata to mint to the tree
  // This data is hashed and stored as a leaf of the Merkle tree
  const compressedNFTMetadata = createCompressedNFTMetadata(payer.publicKey)

  // Derive the tree authority PDA ('TreeConfig' account) from the tree account
  const [treeAuthority] = PublicKey.findProgramAddressSync(
    [treeAddress.toBuffer()],
    BUBBLEGUM_PROGRAM_ID
  )

  // Create the instruction to "mint" the compressed NFT to the tree
  const mintIx = createMintV1Instruction(
    {
      payer: payer.publicKey, // The account that will pay for the transaction
      merkleTree: treeAddress, // The address of the tree account
      treeAuthority, // The "TreeConfig" account, should be a PDA derived using the tree account address as a seed
      treeDelegate: payer.publicKey, // The delegate of the tree account, should be the same as the tree creator by default
      leafOwner: payer.publicKey, // The owner of the compressed NFT being minted to the tree
      leafDelegate: payer.publicKey, // The delegate of the compressed NFT being minted to the tree
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, // The SPL Account Compression program
      logWrapper: SPL_NOOP_PROGRAM_ID, // The log wrapper program, logs the metadata in CPI logs to be used by indexing services
    },
    {
      message: Object.assign(compressedNFTMetadata), // The cNFT metadata
    }
  )

  try {
    // Create new transaction and add the instruction
    const tx = new Transaction().add(mintIx)

    // Set the fee payer for the transaction
    tx.feePayer = payer.publicKey

    // Send the transaction
    const txSignature = await sendAndConfirmTransaction(
      connection,
      tx,
      [payer],
      { commitment: "confirmed", skipPreflight: true }
    )

    console.log(`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`)

    // Extract the asset ID from the transaction logs
    const assetId = await extractAssetId(connection, txSignature, treeAddress)
    return assetId
  } catch (err) {
    console.error("\nFailed to mint compressed NFT:", err)
    throw err
  }
}

// Helper function to transfer a compressed NFT
async function transferCompressedNFT(
  connection: Connection, // The connection to Solana cluster
  assetId: PublicKey, // The assetID of the compressed NFT to transfer
  sender: Keypair, // The sender of the compressed NFT
  receiver: Keypair // The receiver of the compressed NFT
) {
  try {
    // Retrieve the asset data and the asset proof data using Helius Digital Assets Standard (DAS) API
    const [assetData, assetProofData] = await Promise.all([
      heliusApi("getAsset", { id: assetId.toBase58() }),
      heliusApi("getAssetProof", { id: assetId.toBase58() }),
    ])

    // Destructure the required data from assetData and assetProofData
    const { compression, ownership } = assetData
    const { proof, root } = assetProofData

    // Public keys for the tree, owner, and delegate
    const treePublicKey = new PublicKey(compression.tree)
    const ownerPublicKey = new PublicKey(ownership.owner)
    const delegatePublicKey = ownership.delegate
      ? new PublicKey(ownership.delegate)
      : ownerPublicKey

    // Get the Merkle tree account
    const treeAccount = await ConcurrentMerkleTreeAccount.fromAccountAddress(
      connection,
      treePublicKey
    )

    // Get the tree authority and canopy depth
    const treeAuthority = treeAccount.getAuthority()
    const canopyDepth = treeAccount.getCanopyDepth() || 0

    // Convert the proof path into account metadata
    // These will be used as the remaining accounts for the transfer instruction
    // Note: may be empty if the tree canopy is large enough, meaning the required proof is stored on-chain as part of the tree account
    const proofPath: AccountMeta[] = proof
      .map((node: string) => ({
        pubkey: new PublicKey(node),
        isSigner: false,
        isWritable: false,
      }))
      .slice(0, proof.length - canopyDepth)

    // The new "owner" of the leaf is the receiver
    const newLeafOwner = receiver.publicKey

    // Create the transfer instruction
    const transferIx = createTransferInstruction(
      {
        merkleTree: treePublicKey, // The address of the tree account
        treeAuthority, // The "TreeConfig" account, also the authority of the tree account
        leafOwner: ownerPublicKey, // The current owner of the compressed NFT
        leafDelegate: delegatePublicKey, // The current delegate of the compressed NFT
        newLeafOwner, // The new owner of the compressed NFT
        logWrapper: SPL_NOOP_PROGRAM_ID, // The log wrapper program, logs data to CPI logs to be used by indexing services
        compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, // The SPL Account Compression program
        anchorRemainingAccounts: proofPath, // If needed, remaining parts of the proof provided as remaining "accounts"
      },
      {
        root: [...new PublicKey(root.trim()).toBytes()], // The root hash of the tree
        dataHash: [...new PublicKey(compression.data_hash.trim()).toBytes()], // The current data hash of the compressed NFT
        creatorHash: [
          ...new PublicKey(compression.creator_hash.trim()).toBytes(), // The creator hash of the compressed NFT
        ],
        nonce: compression.leaf_id, // The leaf of the compressed NFT on the tree
        index: compression.leaf_id, // The leaf of the compressed NFT on the tree
      },
      BUBBLEGUM_PROGRAM_ID // The Bubblegum program
    )

    const tx = new Transaction().add(transferIx)
    tx.feePayer = sender.publicKey
    const txSignature = await sendAndConfirmTransaction(
      connection,
      tx,
      [sender],
      {
        commitment: "confirmed",
        skipPreflight: true,
      }
    )
    console.log(`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`)
  } catch (err: any) {
    console.error("\nFailed to transfer nft:", err)
    throw err
  }
}

// Helper function to burn a compressed NFT
async function burnCompressedNFT(
  connection: Connection, // The connection to Solana cluster
  assetId: PublicKey, // The assetID of the compressed NFT to burn
  payer: Keypair // The payer of the transaction
) {
  try {
    // Retrieve the asset data and the asset proof data using Helius Digital Assets Standard (DAS) API
    const [assetData, assetProofData] = await Promise.all([
      heliusApi("getAsset", { id: assetId.toBase58() }),
      heliusApi("getAssetProof", { id: assetId.toBase58() }),
    ])

    // Destructure the required data from assetData and assetProofData
    const { compression, ownership } = assetData
    const { proof, root } = assetProofData

    // Public keys for the tree, owner, and delegate
    const treePublicKey = new PublicKey(compression.tree)
    const ownerPublicKey = new PublicKey(ownership.owner)
    const delegatePublicKey = ownership.delegate
      ? new PublicKey(ownership.delegate)
      : ownerPublicKey

    // Get the Merkle tree account
    const treeAccount = await ConcurrentMerkleTreeAccount.fromAccountAddress(
      connection,
      treePublicKey
    )

    // Get the tree authority and canopy depth
    const treeAuthority = treeAccount.getAuthority()
    const canopyDepth = treeAccount.getCanopyDepth() || 0

    // Convert the proof path into account metadata
    const proofPath: AccountMeta[] = proof
      .map((node: string) => ({
        pubkey: new PublicKey(node),
        isSigner: false,
        isWritable: false,
      }))
      .slice(0, proof.length - canopyDepth)

    // Create the burn instruction
    const burnIx = createBurnInstruction(
      {
        treeAuthority, // The "TreeConfig" account, also the authority of the tree account
        leafOwner: ownerPublicKey, // The current owner of the compressed NFT
        leafDelegate: delegatePublicKey, // The current delegate of the compressed NFT
        merkleTree: treePublicKey, // The address of the tree account
        logWrapper: SPL_NOOP_PROGRAM_ID, // The log wrapper program, logs data to CPI logs to be used by indexing services
        compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, // The SPL Account Compression program
        anchorRemainingAccounts: proofPath, // If needed, remaining parts of the proof provided as remaining "accounts"
      },
      {
        root: [...new PublicKey(root.trim()).toBytes()], // The root hash of the tree
        dataHash: [...new PublicKey(compression.data_hash.trim()).toBytes()], // The current data hash of the compressed NFT
        creatorHash: [
          ...new PublicKey(compression.creator_hash.trim()).toBytes(), // The creator hash of the compressed NFT
        ],
        nonce: compression.leaf_id, // The leaf of the compressed NFT on the tree
        index: compression.leaf_id, // The leaf of the compressed NFT on the tree
      },
      BUBBLEGUM_PROGRAM_ID // The Bubblegum program
    )

    const tx = new Transaction().add(burnIx)
    tx.feePayer = payer.publicKey
    const txSignature = await sendAndConfirmTransaction(
      connection,
      tx,
      [payer],
      {
        commitment: "confirmed",
        skipPreflight: true,
      }
    )
    console.log(`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`)
  } catch (err: any) {
    console.error("\nFailed to burn NFT:", err)
    throw err
  }
}

main()
