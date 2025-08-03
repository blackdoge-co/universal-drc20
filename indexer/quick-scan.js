#!/usr/bin/env node

const { exec } = require('child_process');
const { promisify } = require('util');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

const execAsync = promisify(exec);

// Increase buffer size and add timeout
const execOptions = { 
  maxBuffer: 1024 * 1024 * 10, // 10MB buffer
  timeout: 30000 // 30 second timeout per command
};

let db = null;

async function initializeDatabase() {
  try {
    const dbPath = path.join(process.cwd(), 'data', 'drc20-indexer.db');
    
    db = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });
    
    console.log('✅ Database connected');
    return true;
  } catch (error) {
    console.error('❌ Failed to connect to database:', error.message);
    return false;
  }
}

async function isTokenDeployed(tick) {
  if (!db) return false;
  
  try {
    const token = await db.get('SELECT tick FROM tokens WHERE tick = ?', [tick.toUpperCase()]);
    return !!token;
  } catch (error) {
    console.error(`❌ Error checking if token ${tick} is deployed:`, error.message);
    return false;
  }
}

async function saveTransaction(blockHeight, txid, drc20Data, opReturnHex) {
  if (!db) return false;
  
  try {
    // Only save if it's a deploy or if the token is already deployed
    if (drc20Data.op === 'deploy') {
      // Save deploy transaction and token
      await db.run(`
        INSERT OR IGNORE INTO tokens 
        (tick, max_supply, mint_limit, deploy_txid, deploy_block, deploy_address, created_at)
        VALUES (?, ?, ?, ?, ?, '', CURRENT_TIMESTAMP)
      `, [
        drc20Data.tick.toUpperCase(),
        drc20Data.max || '0',
        drc20Data.lim || '0',
        txid,
        blockHeight
      ]);
      
      console.log(`💾 Saved deploy: ${drc20Data.tick}`);
    } else if (drc20Data.op === 'mint' && await isTokenDeployed(drc20Data.tick)) {
      // Only save mint if token was deployed first
      await db.run(`
        INSERT OR IGNORE INTO transactions 
        (txid, block_height, block_hash, operation, tick, amount, from_address, to_address, raw_json, service_fee_amount, is_blackdoge_tx, is_valid, created_at)
        VALUES (?, ?, '', ?, ?, ?, '', '', ?, '0', 0, 1, CURRENT_TIMESTAMP)
      `, [
        txid,
        blockHeight,
        drc20Data.op,
        drc20Data.tick.toUpperCase(),
        drc20Data.amt || '0',
        JSON.stringify(drc20Data)
      ]);
      
      console.log(`💾 Saved mint: ${drc20Data.tick} ${drc20Data.amt}`);
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Error saving transaction ${txid}:`, error.message);
    return false;
  }
}

async function getLastProcessedBlock() {
  if (!db) return null;
  
  try {
    const result = await db.get('SELECT last_block_height FROM indexer_state WHERE id = 1');
    return result ? result.last_block_height : null;
  } catch (error) {
    console.error('❌ Error getting last processed block:', error.message);
    return null;
  }
}

async function updateLastProcessedBlock(height) {
  if (!db) return;
  
  try {
    await db.run(`
      INSERT OR REPLACE INTO indexer_state (id, last_block_height, last_block_hash, updated_at)
      VALUES (1, ?, '', CURRENT_TIMESTAMP)
    `, [height]);
  } catch (error) {
    console.error('❌ Error updating last processed block:', error.message);
  }
}

async function scanBlockRange(startBlock, endBlock) {
  console.log(`🔍 Scanning blocks ${startBlock} to ${endBlock}...`);
  
  let drc20Transactions = [];
  
  for (let blockHeight = startBlock; blockHeight <= endBlock; blockHeight++) {
    try {
      const { stdout: blockHash } = await execAsync(`dogecoin-cli getblockhash ${blockHeight}`, execOptions);
      const hash = blockHash.trim();

      const { stdout: blockData } = await execAsync(`dogecoin-cli getblock ${hash} 2`, execOptions);
      const block = JSON.parse(blockData);

      for (const tx of block.tx) {
        for (const vout of tx.vout) {
          if (vout.scriptPubKey && vout.scriptPubKey.type === 'nulldata' && vout.scriptPubKey.hex) {
            const opReturnHex = vout.scriptPubKey.hex;
            const drc20Data = parseDRC20FromHex(opReturnHex);
            
            if (drc20Data) {
              drc20Transactions.push({
                blockHeight,
                txid: tx.txid,
                data: drc20Data,
                hex: opReturnHex
              });
              
              // Save to database
              await saveTransaction(blockHeight, tx.txid, drc20Data, opReturnHex);
              
              console.log(`🎯 Block ${blockHeight}: ${drc20Data.op} ${drc20Data.tick} ${drc20Data.amt || ''} - ${tx.txid}`);
            }
          }
        }
      }
      
      if (blockHeight % 100 === 0) {
        console.log(`📊 Progress: Block ${blockHeight}, found ${drc20Transactions.length} DRC-20 transactions`);
      }
      
    } catch (error) {
      console.error(`❌ Error processing block ${blockHeight}:`, error.message);
    }
  }
  
  return drc20Transactions;
}

async function initialScan() {
  console.log('🔍 Initial DRC-20 scan...');
  
  try {
    // Get current height
    const { stdout } = await execAsync('dogecoin-cli getblockcount');
    const currentHeight = parseInt(stdout.trim());
    
    // Check if we have a last processed block
    const lastProcessed = await getLastProcessedBlock();
    
    let startBlock;
    if (lastProcessed) {
      startBlock = lastProcessed + 1;
      console.log(`📍 Resuming from block ${startBlock} (last processed: ${lastProcessed})`);
    } else {
      // First run - scan last 5000 blocks to catch up
      startBlock = Math.max(5700000, currentHeight - 5000);
      console.log(`🆕 First run - scanning last 5000 blocks from ${startBlock}`);
    }
    
    if (startBlock <= currentHeight) {
      const transactions = await scanBlockRange(startBlock, currentHeight);
      await updateLastProcessedBlock(currentHeight);
      
      console.log(`✅ Initial scan complete: ${transactions.length} DRC-20 transactions found`);
    } else {
      console.log(`✅ Already up to date at block ${currentHeight}`);
    }
    
  } catch (error) {
    console.error('❌ Initial scan failed:', error.message);
  }
}

async function continuousMonitoring() {
  console.log('🔄 Starting continuous monitoring...');
  
  while (true) {
    try {
      // Get current blockchain height
      const { stdout } = await execAsync('dogecoin-cli getblockcount');
      const currentHeight = parseInt(stdout.trim());
      
      // Get our last processed block
      const lastProcessed = await getLastProcessedBlock() || currentHeight - 1;
      
      if (currentHeight > lastProcessed) {
        const newBlocks = currentHeight - lastProcessed;
        console.log(`🆕 Found ${newBlocks} new block(s): ${lastProcessed + 1} to ${currentHeight}`);
        
        const transactions = await scanBlockRange(lastProcessed + 1, currentHeight);
        await updateLastProcessedBlock(currentHeight);
        
        if (transactions.length > 0) {
          console.log(`✅ Processed ${transactions.length} new DRC-20 transactions`);
        }
      } else {
        process.stdout.write('.');
      }
      
      // Wait 30 seconds before next check
      await new Promise(resolve => setTimeout(resolve, 30000));
      
    } catch (error) {
      console.error('❌ Monitoring error:', error.message);
      console.log('⏳ Retrying in 60 seconds...');
      await new Promise(resolve => setTimeout(resolve, 60000));
    }
  }
}

async function quickScan() {
  console.log('🚀 DRC-20 Continuous Indexer Starting...');
  
  // Initialize database connection
  const dbConnected = await initializeDatabase();
  if (!dbConnected) {
    console.error('❌ Cannot proceed without database connection');
    return;
  }
  
  try {
    // Do initial scan/catch up
    await initialScan();
    
    // Start continuous monitoring
    await continuousMonitoring();
    
  } catch (error) {
    console.error('❌ Indexer failed:', error.message);
  } finally {
    // Close database connection
    if (db) {
      await db.close();
      console.log('🗄️ Database connection closed');
    }
  }
}

function parseDRC20FromHex(opReturnHex) {
  try {
    let dataHex = opReturnHex;
    
    if (dataHex.startsWith('6a')) {
      dataHex = dataHex.slice(2);
      
      const lengthByte = parseInt(dataHex.slice(0, 2), 16);
      if (lengthByte <= 75) {
        dataHex = dataHex.slice(2);
      } else if (lengthByte === 76) {
        dataHex = dataHex.slice(4);
      } else {
        return null;
      }
    }

    const jsonString = Buffer.from(dataHex, 'hex').toString('utf8');
    const data = JSON.parse(jsonString);
    
    if (data.p === 'drc-20' && data.op && data.tick) {
      return data;
    }
    
    return null;
  } catch (error) {
    return null;
  }
}
