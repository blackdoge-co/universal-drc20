DRC-20 Universal Protocol

  Simple, safe tokens on Dogecoin

  What is DRC-20?

  DRC-20 on OP_RETURN brings Bitcoin's BRC-20 token standard to Dogecoin with improvements. Create fungible tokens using
  simple JSON in OP_RETURN outputs.

  Key Benefits:
  - Simple: Just JSON in OP_RETURN transactions
  - Safe: Address-based balances (can't accidentally burn tokens)
  - Efficient: Small, prunable data
  - Compatible: Works with any Dogecoin wallet

  How It Works

  1. Deploy a Token

  {
    "p": "drc-20",
    "op": "deploy",
    "tick": "DOG",
    "max": "1000000",
    "lim": "1000"
  }

  2. Mint Tokens

  {
    "p": "drc-20",
    "op": "mint",
    "tick": "DOG",
    "amt": "1000"
  }

  3. Transfer Tokens

  {
    "p": "drc-20",
    "op": "transfer",
    "tick": "DOG",
    "amt": "500"
  }

  Transaction Structure

  Every DRC-20 operation follows this pattern:
  Input:    Your DOGE UTXOs
  Output 1: OP_RETURN with JSON
  Output 2: Recipient address  
  Output 3: Change (optional)

  Safety Model

  Address-Based Balances: Your tokens are tied to your Dogecoin address, not specific UTXOs. This means:
  - ✅ Spending DOGE won't affect your tokens
  - ✅ Only valid transfers can move tokens
  - ✅ No accidental token burning

  Protocol Rules

  - JSON must be ≤ 80 bytes (OP_RETURN limit)
  - Tickers must be unique across all DRC-20 standards
  - Respect max supply and mint limits
  - All outputs must meet dust threshold

  Blackdoge: Live Implementation

  Blackdoge is the first web platform implementing DRC-20 Universal:

  Features

  - Web Interface: Click to mint tokens
  - Auto Discovery: New tokens appear automatically
  - UTXO Management: Smart UTXO handling
  - Real-time Stats: Live minting progress

  Architecture

  Next.js Frontend → API Routes → Dogecoin RPC → Blockchain
                        ↓
                SQLite Indexer → Token Database

  Example Usage

  1. Import your Dogecoin wallet
  2. Click a token card to mint
  3. Transaction broadcasts automatically
  4. Track progress in real-time

  Getting Started

  Users

  - Visit Blackdoge to try DRC-20 minting
  - Import your wallet (keys never stored)
  - Start with small amounts

  Developers

  - Study DogeReturn source code
  - Run your own indexer
  - Build DRC-20 applications


  Why DRC-20 Universal?

  | Feature       | DRC-20 Universal | Other Standards    |
  |---------------|------------------|--------------------|
  | Safety        | Address-based    | UTXO-based (risky) |
  | Size          | ≤80 bytes        | Larger             |
  | Compatibility | Any wallet       | Special wallets    |
  | Efficiency    | Prunable         | Permanent          |

  The DRC-20 Universal Protocol makes token creation on Dogecoin simple, safe, and accessible to everyone.

