# Certen Pending Service

Background service that discovers pending multi-signature transactions for Certen users by scanning the Accumulate network and syncing to Firestore.

## Overview

The Certen Pending Service is a polling-based discovery service that identifies transactions requiring signatures from Certen users. It scans the Accumulate network for pending transactions, traces signing paths through delegation chains, and updates each user's pending actions in Firestore for real-time display in the web application.

Key capabilities:

1. **Transaction Discovery**: Scans Accumulate accounts for pending multi-sig transactions
2. **Signing Path Analysis**: Traces delegation chains to determine which keys can sign
3. **Firestore Sync**: Updates user-specific pending action collections in real-time
4. **Concurrent Processing**: Processes multiple users in parallel with configurable concurrency

## Architecture

```
+------------------------------------------------------------------+
|                     Certen Pending Service                        |
+------------------------------------------------------------------+
|                                                                   |
|  +------------------+    +------------------+    +---------------+ |
|  |   Poller Loop    |    |   Discovery      |    |  Signing Path | |
|  |   (Interval)     |--->|   Service        |--->|  Service      | |
|  +------------------+    +------------------+    +---------------+ |
|          |                       |                      |         |
|          v                       v                      v         |
|  +------------------+    +------------------+    +---------------+ |
|  |   State Manager  |    |   Accumulate     |    |  Delegation   | |
|  |   (Firestore)    |    |   Client         |    |  Traversal    | |
|  +------------------+    +------------------+    +---------------+ |
|                                                                    |
+------------------------------------------------------------------+
                                  |
                                  v
+------------------------------------------------------------------+
|                      External Services                            |
+------------------------------------------------------------------+
|  - Accumulate Network (v3 API)                                    |
|  - Firebase Firestore                                             |
+------------------------------------------------------------------+
```

## Features

- **Periodic Polling**: Configurable interval scanning (default: 45 seconds)
- **Concurrent User Processing**: Semaphore-based concurrency control
- **Delegation Chain Traversal**: Follows authority delegations to depth 10
- **Incremental Updates**: Tracks added/removed pending actions
- **Graceful Shutdown**: Handles SIGINT/SIGTERM for clean exit
- **Dry Run Mode**: Test discovery without writing to Firestore

## Prerequisites

- Node.js 18+
- Firebase project with Firestore enabled
- Accumulate network access

## Quick Start

```bash
# Clone repository
git clone https://github.com/certenIO/certen-pending-service.git
cd certen-pending-service

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Edit .env with your configuration

# Build
npm run build

# Start service
npm start
```

## Installation

### Development Setup

```bash
# Install dependencies
npm install

# Run in development mode with hot reload
npm run dev

# Build for production
npm run build

# Start production build
npm start
```

### Docker

```bash
# Build image
docker build -t certen-pending-service:latest .

# Run container
docker run -d \
  --name certen-pending \
  -e FIREBASE_PROJECT_ID=your-project \
  -e GOOGLE_APPLICATION_CREDENTIALS=/app/credentials.json \
  -e ACCUMULATE_API_URL=https://mainnet.accumulatenetwork.io/v3 \
  -v /path/to/credentials.json:/app/credentials.json:ro \
  certen-pending-service:latest
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FIREBASE_PROJECT_ID` | Yes | - | Firebase project ID |
| `GOOGLE_APPLICATION_CREDENTIALS` | Yes | - | Path to service account JSON |
| `FIRESTORE_EMULATOR_HOST` | No | - | Firestore emulator (dev only) |
| `ACCUMULATE_API_URL` | No | mainnet | Accumulate v3 API endpoint |
| `ACCUMULATE_NETWORK` | No | mainnet | Network: mainnet/testnet/devnet |
| `POLL_INTERVAL_SEC` | No | 45 | Seconds between poll cycles |
| `USER_CONCURRENCY` | No | 8 | Max concurrent user processing |
| `MAX_RETRIES` | No | 3 | API retry attempts |
| `DELEGATION_DEPTH` | No | 10 | Max delegation chain depth |
| `PENDING_PAGE_SIZE` | No | 100 | Pending query page size |
| `USERS_COLLECTION` | No | users | Firestore users collection |
| `DRY_RUN` | No | false | Disable Firestore writes |
| `ENABLE_DEBUG_DUMP` | No | false | Dump debug state |
| `LOG_LEVEL` | No | info | Logging: debug/info/warn/error |

### Network Endpoints

| Network | Endpoint |
|---------|----------|
| Mainnet | `https://mainnet.accumulatenetwork.io/v3` |
| Kermit Testnet | `https://kermit.accumulatenetwork.io/v3` |
| DevNet | `http://localhost:26660/v3` |

## Firestore Schema

### Users Collection (`/users/{uid}`)

```typescript
interface CertenUser {
  uid: string;
  email: string;
  adis: string[];  // Array of ADI URLs user controls
}
```

### Pending Actions Subcollection (`/users/{uid}/pendingActions/{actionId}`)

```typescript
interface PendingAction {
  txHash: string;          // Transaction hash
  principal: string;       // Account URL
  signerUrl: string;       // Key page URL that can sign
  signerKeyHash: string;   // Public key hash
  status: 'pending' | 'signed' | 'expired';
  expiresAt: Timestamp;
  discoveredAt: Timestamp;
  lastUpdated: Timestamp;
  transactionType: string;
  memo?: string;
}
```

### Computed State Subcollection (`/users/{uid}/computedState/pending`)

```typescript
interface ComputedPendingState {
  totalCount: number;
  lastPolled: Timestamp;
  actionsByAccount: Record<string, number>;
}
```

## Project Structure

```
certen-pending-service/
├── src/
│   ├── clients/
│   │   ├── accumulate.client.ts   # Accumulate API client
│   │   └── firestore.client.ts    # Firestore client
│   ├── services/
│   │   ├── pending-discovery.service.ts  # Transaction discovery
│   │   ├── signing-path.service.ts       # Delegation traversal
│   │   ├── state-manager.service.ts      # Firestore updates
│   │   └── index.ts
│   ├── poller/
│   │   └── poller.ts              # Main polling loop
│   ├── types/
│   │   ├── accumulate.types.ts    # Accumulate API types
│   │   ├── firestore.types.ts     # Firestore document types
│   │   ├── pending.types.ts       # Pending action types
│   │   └── index.ts
│   ├── utils/
│   │   ├── logger.ts              # Winston logger
│   │   ├── hash-normalizer.ts     # Hash format utilities
│   │   ├── url-normalizer.ts      # ADI URL utilities
│   │   └── retry.ts               # Retry and semaphore
│   ├── config.ts                  # Configuration loader
│   └── index.ts                   # Entry point
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## Discovery Process

The service executes the following steps each poll cycle:

1. **List Users**: Query Firestore for users with associated ADIs
2. **Discover Signing Paths**: For each ADI, trace delegation chains to find all authorized key pages
3. **Scan Pending Transactions**: Query Accumulate for pending transactions on discovered principals
4. **Match Signers**: Determine which user keys can sign each pending transaction
5. **Update Firestore**: Add new pending actions, remove completed/expired ones
6. **Log Statistics**: Report cycle duration, users processed, actions found

## Development

### Running Tests

```bash
# Run tests
npm test

# Watch mode
npm run test:watch
```

### Linting

```bash
npm run lint
```

### Local Development with Emulators

```bash
# Start Firestore emulator (from certen-web-app)
cd ../certen-web-app
npm run emulators

# Configure service to use emulator
export FIRESTORE_EMULATOR_HOST=localhost:8080
npm run dev
```

## Monitoring

The service logs key metrics each poll cycle:

| Metric | Description |
|--------|-------------|
| `totalUsers` | Users in Firestore |
| `processedUsers` | Users successfully processed |
| `skippedUsers` | Users without ADIs |
| `failedUsers` | Users with errors |
| `totalPending` | Total pending actions found |
| `firestoreWrites` | Firestore update operations |
| `duration` | Cycle duration in milliseconds |

Example log output:

```
[INFO] Poll cycle complete {
  "totalUsers": 150,
  "processedUsers": 148,
  "skippedUsers": 2,
  "failedUsers": 0,
  "totalPending": 47,
  "firestoreWrites": 148,
  "duration": 12340
}
```

## Deployment

### Systemd Service

```ini
[Unit]
Description=Certen Pending Discovery Service
After=network.target

[Service]
Type=simple
User=certen
WorkingDirectory=/opt/certen-pending-service
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### Cloud Run / GCP

```bash
# Build and push
gcloud builds submit --tag gcr.io/PROJECT_ID/certen-pending-service

# Deploy
gcloud run deploy certen-pending-service \
  --image gcr.io/PROJECT_ID/certen-pending-service \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars FIREBASE_PROJECT_ID=your-project
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No users found | Check `USERS_COLLECTION` matches Firestore |
| Connection refused | Verify `ACCUMULATE_API_URL` endpoint |
| Permission denied | Check Firebase service account permissions |
| High latency | Reduce `USER_CONCURRENCY` or increase `POLL_INTERVAL_SEC` |

## Related Components

| Component | Repository | Description |
|-----------|------------|-------------|
| Web App | `certen-web-app` | Displays pending actions to users |
| API Bridge | `api-bridge` | Transaction construction |
| Key Vault | `key-vault-signer` | Signs pending transactions |

## License

MIT License

Copyright 2025 Certen Protocol. All rights reserved.
