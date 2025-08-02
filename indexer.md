# Doge Indexer - Technical Specification

## Overview

The Doge Indexer is the reference implementation of the DRC-20 Universal Protocol for Dogecoin. It provides real-time indexing of DRC-20 operations embedded in OP_RETURN outputs on the Dogecoin blockchain.

## Architecture

### Core Components

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Dogecoin      │    │     Doge        │    │      API        │
│   Full Node     │◄──►│    Indexer      │◄──►│    Gateway      │
│   (RPC API)     │    │   (Core Logic)  │    │   (REST API)    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         │                       ▼                       │
         │              ┌─────────────────┐              │
         │              │   Database      │              │
         └──────────────►│   (PostgreSQL)  │◄─────────────┘
                        └─────────────────┘
```

### 1. Block Processor
- **Purpose**: Monitor Dogecoin blockchain for new blocks
- **Function**: Parse transactions and extract OP_RETURN data
- **Integration**: Direct RPC connection to Dogecoin Core

### 2. Operation Parser  
- **Purpose**: Decode and validate DRC-20 operations
- **Function**: Parse JSON payloads and enforce consensus rules
- **Validation**: Syntax, semantics, and business logic validation

### 3. State Manager
- **Purpose**: Maintain global DRC-20 state (balances, supplies)
- **Function**: Apply valid operations to update balances
- **Atomicity**: Ensure consistent state updates

### 4. API Server
- **Purpose**: Provide external access to DRC-20 data
- **Function**: RESTful API for wallets and applications
- **Features**: Real-time data, historical queries, statistics
