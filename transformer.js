/**
 * Ensures all cross-module timestamps conform to UTC ISO-8601 format.
 */
function normalizeToUTC(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO-8601 timestamp: ${timestamp}`);
  }
  return date.toISOString();
}

/**
 * Maps Sales_CRM (sales.deal_closes) -> Cust_Support record
 * Rules:
 * 1. Sales_CRM.customer_id    -> Cust_Support.client_key (Direct key match)
 * 2. Sales_CRM.order_status   -> Cust_Support.delivery_flag (1 -> true, else false)
 * 3. Sales_CRM.customer_name  -> Cust_Support.account_name (String trim normalization)
 */
function transformSalesToSupport(salesEvent) {
  const { payload, timestamp } = salesEvent;

  const clientKey = String(payload.customerId || payload.customer_id || "").trim();
  if (!clientKey) {
    throw new Error("Missing authoritative customerId for 360-degree profile mapping.");
  }

  const deliveryFlag = Number(payload.orderStatus) === 1;

  return {
    event: "support.client_profile_synced",
    timestamp: normalizeToUTC(timestamp),
    targetModule: "Cust_Support",
    data: {
      client_key: clientKey,
      account_name: String(payload.customerName || "").trim(),
      delivery_flag: deliveryFlag,
      ticket_creation_allowed: deliveryFlag,
      sla_tier: payload.accountTier === "Priority_1" ? "VIP_Gold" : "Standard",
      opportunity_ref: payload.opportunityId,
      payment_status: payload.paymentStatus,
      sales_rep_email: payload.salesRepEmail
    }
  };
}

/**
 * Maps Cust_Support (support.ticket_escalated) -> Sales_CRM update
 * Rules:
 * 1. Cust_Support.client_key    -> Sales_CRM.customer_id (Direct key match)
 * 2. Cust_Support.sla_tier      -> Sales_CRM.account_tier ("VIP_Gold" -> "Priority_1")
 * 3. Cust_Support.ticket_status -> Sales_CRM.status (If OPEN && VIP_Gold -> "AT_FRONT")
 */
function transformSupportToSales(supportEvent) {
  const { payload, timestamp } = supportEvent;

  const customerId = String(payload.client_key || "").trim();
  if (!customerId) {
    throw new Error("Missing client_key; cannot resolve authoritative Sales_CRM.customer_id.");
  }

  const tierMap = {
    VIP_Gold: "Priority_1",
    Standard: "Priority_2"
  };
  const mappedAccountTier = tierMap[payload.sla_tier] || "Priority_2";

  // Conditional evaluation: ticket_status == "OPEN" && sla_tier == "VIP_Gold" -> "AT_FRONT"
  const crmStatus =
    payload.ticket_status === "OPEN" && payload.sla_tier === "VIP_Gold"
      ? "AT_FRONT"
      : "ACTIVE";

  return {
    event: "sales.account_risk_updated",
    timestamp: normalizeToUTC(timestamp),
    targetModule: "Sales_CRM",
    data: {
      customer_id: customerId,
      customer_name: String(payload.account_name || "").trim(),
      account_tier: mappedAccountTier,
      status: crmStatus,
      escalated_ticket_id: payload.ticket_id,
      issue_category: payload.issue_category,
      issue_summary: payload.issue_summary
    }
  };
}

module.exports = {
  normalizeToUTC,
  transformSalesToSupport,
  transformSupportToSales
};