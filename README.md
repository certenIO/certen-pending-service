# Certen Pending Service

Backend service that discovers pending multi-signature transactions on the Accumulate network and populates user inboxes via Firestore.

## Overview

The service continuously polls the Accumulate network to find pending transactions that require user signatures. It matches discovered transactions against user key pages stored in Firestore and writes pending actions to each user's collection.

## Requirements

- Node.js 18+
- Firebase service account credentials
- Access to Accumulate network RPC

## Installation

```bash
npm install
cp .env.example .env
# Edit .env with your configuration
```

## Usage

Development:
```bash
npm run dev
```

Production:
```bash
npm run build
npm start
```

Docker:
```bash
docker-compose up -d pending-service
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `FIREBASE_PROJECT_ID` | required | Firebase project ID |
| `GOOGLE_APPLICATION_CREDENTIALS` | - | Path to service account JSON |
| `ACCUMULATE_API_URL` | `https://mainnet.accumulatenetwork.io/v3` | Accumulate RPC endpoint |
| `POLL_INTERVAL_SEC` | `45` | Seconds between poll cycles |
| `USER_CONCURRENCY` | `8` | Max users processed in parallel |
| `LOG_LEVEL` | `info` | Log level: debug, info, warn, error |

## Firestore Schema

Pending actions are written to `/users/{uid}/pendingActions/{txHash}` with computed stats at `/users/{uid}/computedState/pending`.

## License

MIT
