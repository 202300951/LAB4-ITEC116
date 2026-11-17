const fs = require("fs");
const path = require("path");

const DLQ_FILE = path.join(__dirname, "dead_letter_queue.json");
const INCIDENTS_FILE = path.join(__dirname, "incident_dashboard.json");

// Capped exponential backoff schedule in milliseconds: 2s, 4s, 8s, 16s, 32s
const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 32000];

function readJsonStore(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonStore(filePath, records) {
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2), "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Routes failed events to a persistent Dead-Letter Queue and logs an alert.
 */
function routeToDeadLetterQueue(eventPayload, targetEndpoint, errorMessage) {
  const dlq = readJsonStore(DLQ_FILE);
  const incidentLog = readJsonStore(INCIDENTS_FILE);

  const dlqEntry = {
    dlqId: `DLQ-${Date.now()}`,
    failedAt: new Date().toISOString(),
    targetEndpoint,
    attemptsMade: RETRY_DELAYS_MS.length,
    lastError: errorMessage,
    status: "PENDING_REPROCESS",
    eventPayload
  };

  dlq.push(dlqEntry);
  writeJsonStore(DLQ_FILE, dlq);

  const incidentAlert = {
    incidentId: `INC-${Date.now()}`,
    severity: "HIGH",
    sourceModule: "Sales_CRM",
    targetModule: "Cust_Support",
    message: `Webhook delivery failed after ${RETRY_DELAYS_MS.length} retry cycles. Routed to DLQ (${dlqEntry.dlqId}).`,
    timestamp: new Date().toISOString(),
    dlqRef: dlqEntry.dlqId,
    resolved: false
  };

  incidentLog.push(incidentAlert);
  writeJsonStore(INCIDENTS_FILE, incidentLog);

  console.error(`[ALERT] Incident logged: ${incidentAlert.incidentId} -> ${incidentAlert.message}`);
  return dlqEntry;
}

/**
 * Dispatches a webhook over HTTPS with a 5-attempt capped exponential backoff policy.
 * Pass `delayScale` (default 1) to speed up automated testing without changing policy values.
 */
async function dispatchWebhookWithRetry(eventPayload, deliverFn, options = {}) {
  const { targetEndpoint = "https://api.enterprise.local/support/webhooks", delayScale = 1 } = options;
  let lastError = null;

  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const backoffMs = RETRY_DELAYS_MS[attempt - 1];
    console.log(`[Retry Policy] Attempt ${attempt}/${RETRY_DELAYS_MS.length} scheduled after ${backoffMs / 1000}s...`);
    await sleep(backoffMs * delayScale);

    try {
      const response = await deliverFn(eventPayload);
      console.log(`[Webhook Delivered] Success on Attempt ${attempt} to ${targetEndpoint}`);
      return { success: true, attempt, response };
    } catch (err) {
      lastError = err.message;
      console.warn(`[Attempt ${attempt} Failed] Reason: ${lastError}`);
    }
  }

  const dlqRecord = routeToDeadLetterQueue(eventPayload, targetEndpoint, lastError);
  return { success: false, dlqRecord };
}

/**
 * Manual one-click reprocessing from the Dead-Letter Queue once Customer Service recovers.
 */
async function reprocessFromDLQ(dlqId, deliverFn) {
  const dlq = readJsonStore(DLQ_FILE);
  const incidents = readJsonStore(INCIDENTS_FILE);

  const entry = dlq.find((item) => item.dlqId === dlqId && item.status === "PENDING_REPROCESS");
  if (!entry) {
    throw new Error(`No pending DLQ record found for ID: ${dlqId}`);
  }

  const response = await deliverFn(entry.eventPayload);
  entry.status = "REPROCESSED";
  entry.reprocessedAt = new Date().toISOString();
  writeJsonStore(DLQ_FILE, dlq);

  const linkedIncident = incidents.find((inc) => inc.dlqRef === dlqId);
  if (linkedIncident) {
    linkedIncident.resolved = true;
    linkedIncident.resolvedAt = new Date().toISOString();
    writeJsonStore(INCIDENTS_FILE, incidents);
  }

  console.log(`[Recovery] One-click reprocess succeeded for ${dlqId}`);
  return { reprocessed: true, dlqId, response };
}

module.exports = {
  RETRY_DELAYS_MS,
  dispatchWebhookWithRetry,
  reprocessFromDLQ
};