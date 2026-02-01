#!/bin/bash
# Local development script for Certen Pending Service
#
# Prerequisites:
# - Node.js 18+
# - Firebase service account key (or Firestore emulator)
#
# Usage:
#   ./scripts/local-dev.sh [--emulator]
#
#   --emulator: Use Firestore emulator instead of production Firestore

set -e

USE_EMULATOR=false

# Parse arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --emulator) USE_EMULATOR=true ;;
        *) echo "Unknown parameter: $1"; exit 1 ;;
    esac
    shift
done

# Check for required files
if [ ! -f ".env" ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env
    echo ""
    echo "Please edit .env with your configuration:"
    echo "  - FIREBASE_PROJECT_ID"
    echo "  - GOOGLE_APPLICATION_CREDENTIALS (path to service account key)"
    echo ""
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Start Firestore emulator if requested
if [ "$USE_EMULATOR" = true ]; then
    echo "Starting Firestore emulator..."
    export FIRESTORE_EMULATOR_HOST="localhost:8080"

    # Check if emulator is already running
    if ! nc -z localhost 8080 2>/dev/null; then
        echo "Firestore emulator not running. Starting via docker-compose..."
        docker-compose --profile dev up -d firestore-emulator

        # Wait for emulator to be ready
        echo "Waiting for emulator to start..."
        sleep 5
    fi
fi

# Run the service in development mode
echo ""
echo "=============================================="
echo "Starting Certen Pending Service (development)"
echo "=============================================="
echo ""

npm run dev
