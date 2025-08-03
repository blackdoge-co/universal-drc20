import sqlite3 from 'sqlite3'
import { open, Database } from 'sqlite'
import path from 'path'

export interface DRC20Token {
  tick: string
  name?: string
  maxSupply: string
  mintLimit: string
  deployTxid: string
  deployBlock: number
  deployAddress: string
  createdAt: string
}

export interface DRC20Transaction {
  id: number
  txid: string
  blockHeight: number
  blockHash: string
  operation: 'deploy' | 'mint'
  tick: string
  amount?: string
  fromAddress: string
  toAddress: string
  rawJson: string
  isValid: boolean
  createdAt: string
}

export interface DRC20Balance {
  address: string
  tick: string
  balance: string
  lastUpdated: string
}

export class DRC20Indexer {
  private db: Database | null = null
  private rpcUrl = process.env.DOGECOIN_RPC_URL || 'http://127.0.0.1:22555'
  private auth = Buffer.from(process.env.DOGECOIN_RPC_AUTH || 'user:password').toString('base64')

  /**
   * Initialize the indexer database
   */
  async initialize(): Promise<void> {
    try {
      console.log('🗄️ Initializing DRC-20 indexer database...')
      
      const dbPath = path.join(process.cwd(), 'data', 'drc20-indexer.db')
      
      // Ensure data directory exists
      const fs = require('fs')
      const dataDir = path.dirname(dbPath)
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true })
      }

      this.db = await open({
        filename: dbPath,
        driver: sqlite3.Database
      })

      // Create tables
      await this.createTables()
      console.log('✅ DRC-20 indexer database initialized')
      
    } catch (error: any) {
      console.error('❌ Failed to initialize indexer database:', error.message)
      throw error
    }
  }

  /**
   * Create database tables
   */
  private async createTables(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized')

    // Tokens table (deploy transactions)
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        tick TEXT PRIMARY KEY,
        name TEXT,
        max_supply TEXT NOT NULL,
        mint_limit TEXT NOT NULL,
        deploy_txid TEXT UNIQUE NOT NULL,
        deploy_block INTEGER NOT NULL,
        deploy_address TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Transactions table (only BlackDoge transactions)
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        txid TEXT UNIQUE NOT NULL,
        block_height INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('deploy', 'mint')),
        tick TEXT NOT NULL,
        amount TEXT,
        from_address TEXT NOT NULL,
        to_address TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        service_fee_amount TEXT NOT NULL,
        is_blackdoge_tx BOOLEAN DEFAULT 1,
        is_valid BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Site transactions count (for double verification)
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS site_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        txid TEXT UNIQUE NOT NULL,
        tick TEXT NOT NULL,
        amount TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('deploy', 'mint')),
        user_address TEXT NOT NULL,
        service_fee_paid TEXT NOT NULL DEFAULT '0.01',
        source TEXT NOT NULL DEFAULT 'website',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Balances table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS balances (
        address TEXT NOT NULL,
        tick TEXT NOT NULL,
        balance TEXT NOT NULL DEFAULT '0',
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (address, tick)
      )
    `)

    // Indexer state table (track last processed block)
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS indexer_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_block_height INTEGER NOT NULL,
        last_block_hash TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Verification stats table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS verification_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tick TEXT NOT NULL,
        site_count INTEGER NOT NULL,
        blockchain_count INTEGER NOT NULL,
        is_verified BOOLEAN NOT NULL,
        discrepancy_details TEXT,
        checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Create indexes for performance
    await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_block ON transactions(block_height)`)
    await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_tick ON transactions(tick)`)
    await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_site_transactions_tick ON site_transactions(tick)`)
    await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_balances_address ON balances(address)`)
  }

  /**
   * Get current blockchain height
   */
  async getCurrentBlockHeight(): Promise<number> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${this.auth}`
        },
        body: JSON.stringify({
          method: 'getblockchaininfo',
          params: [],
          id: 1
        })
      })

      const data = await response.json()
      if (data.error) {
        throw new Error(`RPC error: ${data.error.message}`)
      }

      return data.result.blocks
    } catch (error: any) {
      console.error('❌ Failed to get block height:', error.message)
      throw error
    }
  }

  /**
   * Get last processed block from database
   */
  async getLastProcessedBlock(): Promise<{ height: number, hash: string } | null> {
    if (!this.db) throw new Error('Database not initialized')

    try {
      const row = await this.db.get(
        'SELECT last_block_height, last_block_hash FROM indexer_state WHERE id = 1'
      )
      
      if (row) {
        return {
          height: row.last_block_height,
          hash: row.last_block_hash
        }
      }
      
      return null
    } catch (error: any) {
      console.error('❌ Failed to get last processed block:', error.message)
      return null
    }
  }

  /**
   * Update last processed block
   */
  async updateLastProcessedBlock(height: number, hash: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized')

    try {
      await this.db.run(`
        INSERT OR REPLACE INTO indexer_state (id, last_block_height, last_block_hash, updated_at)
        VALUES (1, ?, ?, CURRENT_TIMESTAMP)
      `, [height, hash])
    } catch (error: any) {
      console.error('❌ Failed to update last processed block:', error.message)
      throw error
    }
  }

  /**
   * Parse DRC-20 JSON from OP_RETURN data
   */
  private parseDRC20Json(opReturnHex: string): any | null {
    try {
      // OP_RETURN starts with OP_RETURN opcode (0x6a) + push data length
      // Skip the first few bytes and decode hex to string
      const jsonHex = opReturnHex.slice(4) // Skip OP_RETURN opcode and length
      const jsonString = Buffer.from(jsonHex, 'hex').toString('utf8')
      
      const parsed = JSON.parse(jsonString)
      
      // Validate DRC-20 structure
      if (parsed.p === 'drc20' && ['deploy', 'mint'].includes(parsed.op)) {
        return parsed
      }
      
      return null
    } catch (error) {
      return null
    }
  }

  /**
   * Get all deployed tokens
   */
  async getTokens(): Promise<DRC20Token[]> {
    if (!this.db) throw new Error('Database not initialized')

    try {
      const rows = await this.db.all(`
        SELECT 
          tick,
          name,
          max_supply as maxSupply,
          mint_limit as mintLimit,
          deploy_txid as deployTxid,
          deploy_block as deployBlock,
          deploy_address as deployAddress,
          created_at as createdAt
        FROM tokens
        ORDER BY deploy_block DESC
      `)
      
      return rows
    } catch (error: any) {
      console.error('❌ Failed to get tokens:', error.message)
      return []
    }
  }

  /**
   * Get token by tick
   */
  async getToken(tick: string): Promise<DRC20Token | null> {
    if (!this.db) throw new Error('Database not initialized')

    try {
      const row = await this.db.get(`
        SELECT 
          tick,
          name,
          max_supply as maxSupply,
          mint_limit as mintLimit,
          deploy_txid as deployTxid,
          deploy_block as deployBlock,
          deploy_address as deployAddress,
          created_at as createdAt
        FROM tokens
        WHERE tick = ?
      `, [tick.toUpperCase()])
      
      return row || null
    } catch (error: any) {
      console.error('❌ Failed to get token:', error.message)
      return null
    }
  }


  /**
   * Get transaction counts for verification
   */
  async getTransactionCounts(tick?: string): Promise<{[key: string]: {site: number, blockchain: number}}> {
    if (!this.db) throw new Error('Database not initialized')

    try {
      let whereClause = ''
      let params: any[] = []
      
      if (tick) {
        whereClause = 'WHERE tick = ?'
        params = [tick.toUpperCase()]
      }

      // Site counts
      const siteQuery = `
        SELECT tick, COUNT(*) as count 
        FROM site_transactions 
        ${whereClause}
        GROUP BY tick
      `
      const siteCounts = await this.db.all(siteQuery, params)

      // Blockchain counts  
      const blockchainQuery = `
        SELECT tick, COUNT(*) as count 
        FROM transactions 
        WHERE is_blackdoge_tx = 1 ${tick ? 'AND tick = ?' : ''}
        GROUP BY tick
      `
      const blockchainCounts = await this.db.all(blockchainQuery, params)

      // Combine results
      const result: {[key: string]: {site: number, blockchain: number}} = {}
      
      // Add site counts
      for (const row of siteCounts) {
        result[row.tick] = { site: row.count, blockchain: 0 }
      }
      
      // Add blockchain counts
      for (const row of blockchainCounts) {
        if (!result[row.tick]) {
          result[row.tick] = { site: 0, blockchain: row.count }
        } else {
          result[row.tick].blockchain = row.count
        }
      }

      return result
    } catch (error: any) {
      console.error('❌ Failed to get transaction counts:', error.message)
      return {}
    }
  }

  /**
   * Verify transaction counts and record discrepancies
   */
  async verifyTransactionCounts(): Promise<{verified: boolean, details: any[]}> {
    if (!this.db) throw new Error('Database not initialized')

    try {
      const counts = await this.getTransactionCounts()
      const details: any[] = []
      let allVerified = true

      for (const tick in counts) {
        const { site, blockchain } = counts[tick]
        const isVerified = site === blockchain
        
        if (!isVerified) {
          allVerified = false
        }

        details.push({
          tick,
          siteCount: site,
          blockchainCount: blockchain,
          isVerified,
          discrepancy: site - blockchain
        })

        // Record verification result
        await this.db.run(`
          INSERT INTO verification_stats 
          (tick, site_count, blockchain_count, is_verified, discrepancy_details)
          VALUES (?, ?, ?, ?, ?)
        `, [
          tick, 
          site, 
          blockchain, 
          isVerified,
          isVerified ? null : `Site: ${site}, Blockchain: ${blockchain}, Diff: ${site - blockchain}`
        ])
      }

      return { verified: allVerified, details }
    } catch (error: any) {
      console.error('❌ Failed to verify transaction counts:', error.message)
      return { verified: false, details: [] }
    }
  }

  /**
   * Get token statistics
   */
  async getTokenStats(tick: string): Promise<{ totalMinted: number, totalTransactions: number }> {
    if (!this.db) throw new Error('Database not initialized')

    try {
      // Special logic for WOW token - only count mints from "blackdoge"
      if (tick.toUpperCase() === 'WOW') {
        const result = await this.db.get(`
          SELECT 
            COALESCE(SUM(CAST(amount AS INTEGER)), 0) as totalMinted,
            COUNT(*) as totalTransactions
          FROM transactions 
          WHERE tick = ? 
            AND operation = 'mint' 
            AND is_valid = 1
        `, [tick.toUpperCase()])
        
        return {
          totalMinted: result?.totalMinted || 0,
          totalTransactions: result?.totalTransactions || 0
        }
      } else {
        // Normal logic for other tokens
        const result = await this.db.get(`
          SELECT 
            COALESCE(SUM(CAST(amount AS INTEGER)), 0) as totalMinted,
            COUNT(*) as totalTransactions
          FROM transactions 
          WHERE tick = ? 
            AND operation = 'mint' 
            AND is_valid = 1
        `, [tick.toUpperCase()])
        
        return {
          totalMinted: result?.totalMinted || 0,
          totalTransactions: result?.totalTransactions || 0
        }
      }
    } catch (error: any) {
      console.error(`❌ Failed to get token stats for ${tick}:`, error.message)
      return { totalMinted: 0, totalTransactions: 0 }
    }
  }

  /**
   * Record a transaction from our website for tracking
   */
  async recordSiteTransaction(txid: string, tick: string, amount: string, operation: string, address: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized')

    try {
      console.log(`📝 Recording site transaction: ${txid} (${tick} ${operation} ${amount})`)
      
      await this.db.run(`
        INSERT OR IGNORE INTO drc20_transactions 
        (txid, blockHeight, blockHash, operation, tick, amount, fromAddress, toAddress, rawJson, isValid, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `, [
        txid,
        0, // Will be updated when block is processed
        '',
        operation,
        tick.toUpperCase(),
        amount,
        address,
        address,
        JSON.stringify({ p: "drc-20", op: operation, tick: tick.toUpperCase(), amt: amount }),
        1
      ])
      
      console.log(`✅ Site transaction recorded: ${txid}`)
    } catch (error: any) {
      console.error('❌ Failed to record site transaction:', error.message)
      throw error
    }
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      await this.db.close()
      this.db = null
      console.log('🗄️ Indexer database closed')
    }
  }
}

// Export singleton instance
export const drc20Indexer = new DRC20Indexer()
