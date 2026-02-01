#!/bin/bash
# Deploy Certen Pending Service to Google Cloud Run
#
# Prerequisites:
# - gcloud CLI installed and authenticated
# - Docker installed
# - PROJECT_ID environment variable set
#
# Usage:
#   ./scripts/deploy-cloud-run.sh [environment]
#
#   environment: production, staging, or dev (default: staging)

set -e

# Configuration
ENVIRONMENT=${1:-staging}
SERVICE_NAME="certen-pending-service"
REGION="us-central1"

# Validate PROJECT_ID
if [ -z "$PROJECT_ID" ]; then
    echo "ERROR: PROJECT_ID environment variable is required"
    exit 1
fi

# Set environment-specific configuration
case $ENVIRONMENT in
    production)
        ACCUMULATE_URL="https://mainnet.accumulatenetwork.io/v3"
        ACCUMULATE_NETWORK="mainnet"
        MIN_INSTANCES=1
        MAX_INSTANCES=10
        MEMORY="1Gi"
        CPU=2
        ;;
    staging)
        ACCUMULATE_URL="https://testnet.accumulatenetwork.io/v3"
        ACCUMULATE_NETWORK="testnet"
        MIN_INSTANCES=0
        MAX_INSTANCES=3
        MEMORY="512Mi"
        CPU=1
        ;;
    dev)
        ACCUMULATE_URL="https://devnet.accumulatenetwork.io/v3"
        ACCUMULATE_NETWORK="devnet"
        MIN_INSTANCES=0
        MAX_INSTANCES=1
        MEMORY="256Mi"
        CPU=1
        ;;
    *)
        echo "ERROR: Unknown environment: $ENVIRONMENT"
        echo "Usage: $0 [production|staging|dev]"
        exit 1
        ;;
esac

IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
SERVICE_FULL_NAME="${SERVICE_NAME}-${ENVIRONMENT}"

echo "=============================================="
echo "Deploying ${SERVICE_NAME} to ${ENVIRONMENT}"
echo "=============================================="
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Service: ${SERVICE_FULL_NAME}"
echo "Accumulate Network: ${ACCUMULATE_NETWORK}"
echo "=============================================="

# Build the Docker image
echo "Building Docker image..."
docker build -t ${IMAGE_NAME}:${ENVIRONMENT} -t ${IMAGE_NAME}:latest .

# Push to Google Container Registry
echo "Pushing to Container Registry..."
docker push ${IMAGE_NAME}:${ENVIRONMENT}

# Deploy to Cloud Run
echo "Deploying to Cloud Run..."
gcloud run deploy ${SERVICE_FULL_NAME} \
    --image ${IMAGE_NAME}:${ENVIRONMENT} \
    --platform managed \
    --region ${REGION} \
    --no-allow-unauthenticated \
    --set-env-vars "FIREBASE_PROJECT_ID=${PROJECT_ID}" \
    --set-env-vars "ACCUMULATE_API_URL=${ACCUMULATE_URL}" \
    --set-env-vars "ACCUMULATE_NETWORK=${ACCUMULATE_NETWORK}" \
    --set-env-vars "POLL_INTERVAL_SEC=45" \
    --set-env-vars "USER_CONCURRENCY=8" \
    --set-env-vars "LOG_LEVEL=info" \
    --memory ${MEMORY} \
    --cpu ${CPU} \
    --min-instances ${MIN_INSTANCES} \
    --max-instances ${MAX_INSTANCES} \
    --timeout 300 \
    --concurrency 1 \
    --project ${PROJECT_ID}

echo "=============================================="
echo "Deployment complete!"
echo "=============================================="

# Get the service URL
SERVICE_URL=$(gcloud run services describe ${SERVICE_FULL_NAME} \
    --platform managed \
    --region ${REGION} \
    --project ${PROJECT_ID} \
    --format 'value(status.url)')

echo "Service URL: ${SERVICE_URL}"
echo ""
echo "Note: This service runs as a background task and does not expose HTTP endpoints."
echo "Monitor logs with: gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name=${SERVICE_FULL_NAME}' --project ${PROJECT_ID}"
