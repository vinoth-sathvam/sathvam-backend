'use strict';
/**
 * Admin API audit log middleware.
 *
 * Logs every mutating admin request (POST/PUT/PATCH/DELETE) to:
 *   1. admin_audit_logs — HTTP-level audit trail (method, path, status, IP)
 *   2. user_activity_log — rich entity-level trail (action, entity, label, details)
 *
 * Mount AFTER auth middleware so req.user is already populated.
 * Safe to use globally — skips requests with no req.user (unauthenticated),
 * and skips read-only GET/HEAD methods.
 */

const supabase = require('../config/supabase');

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SKIP_PATHS = ['/health', '/api/auth/logout', '/api/user-mgmt/heartbeat',
  '/api/public/heartbeat', '/api/public/pageview', '/api/notifications/subscribe'];

/* ─── Entity extraction from URL path ─── */

const ROUTE_MAP = [
  // Order of specificity matters — more specific patterns first
  { pattern: /\/api\/webstore-orders\/([^/]+)\/admin-add-items/, entity: 'webstore_order', action: 'add_items' },
  { pattern: /\/api\/webstore-orders\/([^/]+)\/addon-merge/, entity: 'webstore_order', action: 'addon_merge' },
  { pattern: /\/api\/webstore-orders\/([^/]+)\/invoice-email/, entity: 'webstore_order', action: 'send_invoice' },
  { pattern: /\/api\/webstore-orders\/bulk/, entity: 'webstore_order', action: 'bulk_update' },
  { pattern: /\/api\/webstore-orders\/([^/]+)/, entity: 'webstore_order' },
  { pattern: /\/api\/webstore-orders\/?$/, entity: 'webstore_order' },

  { pattern: /\/api\/payments\/refund/, entity: 'refund', action: 'initiate_refund' },
  { pattern: /\/api\/payments\/approve-refund\/([^/]+)/, entity: 'refund', action: 'approve' },
  { pattern: /\/api\/payments\/reject-refund\/([^/]+)/, entity: 'refund', action: 'reject' },
  { pattern: /\/api\/payments\/partial-refund/, entity: 'refund', action: 'partial_refund' },
  { pattern: /\/api\/payments\/create-payment-link/, entity: 'payment_link', action: 'create' },
  { pattern: /\/api\/payments/, entity: 'payment' },

  { pattern: /\/api\/products\/stock\/bulk/, entity: 'stock_ledger', action: 'bulk_reset' },
  { pattern: /\/api\/products\/stock\/by-proc\/([^/]+)/, entity: 'stock_ledger', action: 'delete_by_proc' },
  { pattern: /\/api\/products\/stock/, entity: 'stock_ledger' },
  { pattern: /\/api\/products\/offer-notify/, entity: 'product_offer', action: 'notify' },
  { pattern: /\/api\/products\/bulk-offer/, entity: 'product_offer', action: 'bulk_offer' },
  { pattern: /\/api\/products\/clear-offers/, entity: 'product_offer', action: 'clear_offers' },
  { pattern: /\/api\/products\/batch/, entity: 'product', action: 'batch_update' },
  { pattern: /\/api\/products\/([^/]+)/, entity: 'product' },
  { pattern: /\/api\/products\/?$/, entity: 'product' },

  { pattern: /\/api\/procurement\/([^/]+)\/attach-bill/, entity: 'procurement', action: 'attach_bill' },
  { pattern: /\/api\/procurement\/([^/]+)\/invoice/, entity: 'procurement', action: 'remove_invoice' },
  { pattern: /\/api\/procurement\/mark-paid/, entity: 'procurement', action: 'mark_paid' },
  { pattern: /\/api\/procurement\/add-logistics/, entity: 'procurement', action: 'add_logistics' },
  { pattern: /\/api\/procurement\/bulk/, entity: 'procurement', action: 'bulk_import' },
  { pattern: /\/api\/procurement\/([^/]+)/, entity: 'procurement' },
  { pattern: /\/api\/procurement\/?$/, entity: 'procurement' },

  { pattern: /\/api\/vendors\/([^/]+)/, entity: 'vendor' },
  { pattern: /\/api\/vendors\/?$/, entity: 'vendor' },

  { pattern: /\/api\/sales\/([^/]+)/, entity: 'pos_sale' },
  { pattern: /\/api\/sales\/?$/, entity: 'pos_sale' },

  { pattern: /\/api\/b2b\/customers\/([^/]+)\/reset-password/, entity: 'b2b_customer', action: 'reset_password' },
  { pattern: /\/api\/b2b\/customers\/([^/]+)/, entity: 'b2b_customer' },
  { pattern: /\/api\/b2b\/customers\/?$/, entity: 'b2b_customer' },
  { pattern: /\/api\/b2b\/orders\/([^/]+)\/stage/, entity: 'b2b_order', action: 'change_stage' },
  { pattern: /\/api\/b2b\/orders\/([^/]+)\/items/, entity: 'b2b_order', action: 'update_items' },
  { pattern: /\/api\/b2b\/orders\/([^/]+)\/shipped-qtys/, entity: 'b2b_order', action: 'update_shipped' },
  { pattern: /\/api\/b2b\/orders\/([^/]+)\/payment/, entity: 'b2b_payment', action: 'record_payment' },
  { pattern: /\/api\/b2b\/orders\/([^/]+)/, entity: 'b2b_order' },
  { pattern: /\/api\/b2b\/orders\/?$/, entity: 'b2b_order' },
  { pattern: /\/api\/b2b\/projects\/([^/]+)\/email/, entity: 'project', action: 'send_email' },
  { pattern: /\/api\/b2b\/projects\/([^/]+)/, entity: 'project' },
  { pattern: /\/api\/b2b\/projects\/?$/, entity: 'project' },

  { pattern: /\/api\/batches\/([^/]+)/, entity: 'oil_batch' },
  { pattern: /\/api\/batches\/?$/, entity: 'oil_batch' },

  { pattern: /\/api\/flour-batches\/bulk/, entity: 'flour_batch', action: 'bulk_import' },
  { pattern: /\/api\/flour-batches\/([^/]+)/, entity: 'flour_batch' },
  { pattern: /\/api\/flour-batches\/?$/, entity: 'flour_batch' },

  { pattern: /\/api\/spice-batches\/([^/]+)/, entity: 'spice_batch' },
  { pattern: /\/api\/spice-batches\/?$/, entity: 'spice_batch' },

  { pattern: /\/api\/finance\/payables\/([^/]+)\/payments/, entity: 'vendor_bill', action: 'record_payment' },
  { pattern: /\/api\/finance\/payables\/([^/]+)/, entity: 'vendor_bill' },
  { pattern: /\/api\/finance\/payables\/?$/, entity: 'vendor_bill' },
  { pattern: /\/api\/finance\/receivables\/([^/]+)\/record-payment/, entity: 'receivable', action: 'record_payment' },
  { pattern: /\/api\/finance\/receivables\/([^/]+)\/send-reminder/, entity: 'receivable', action: 'send_reminder' },
  { pattern: /\/api\/finance\/bank\/accounts\/([^/]+)/, entity: 'bank_account' },
  { pattern: /\/api\/finance\/bank\/accounts\/?$/, entity: 'bank_account' },
  { pattern: /\/api\/finance\/bank\/transactions\/([^/]+)\/reconcile/, entity: 'bank_transaction', action: 'reconcile' },
  { pattern: /\/api\/finance\/bank\/transactions\/([^/]+)/, entity: 'bank_transaction' },
  { pattern: /\/api\/finance\/bank\/transactions\/?$/, entity: 'bank_transaction' },
  { pattern: /\/api\/finance\/journal\/([^/]+)/, entity: 'journal_entry' },
  { pattern: /\/api\/finance\/journal\/?$/, entity: 'journal_entry' },
  { pattern: /\/api\/finance\/zoho\/sync/, entity: 'zoho_sync', action: 'sync' },
  { pattern: /\/api\/finance\/zoho\/gst/, entity: 'gst_filing' },

  { pattern: /\/api\/payroll\/employees\/([^/]+)/, entity: 'employee' },
  { pattern: /\/api\/payroll\/employees\/?$/, entity: 'employee' },
  { pattern: /\/api\/payroll\/attendance/, entity: 'attendance' },
  { pattern: /\/api\/payroll\/salary-payments\/([^/]+)/, entity: 'salary_payment' },
  { pattern: /\/api\/payroll\/salary-payments\/?$/, entity: 'salary_payment' },
  { pattern: /\/api\/payroll\/pay-run/, entity: 'pay_run', action: 'process' },

  { pattern: /\/api\/expenses\/categories\/([^/]+)/, entity: 'expense_category' },
  { pattern: /\/api\/expenses\/categories\/?$/, entity: 'expense_category' },
  { pattern: /\/api\/expenses\/([^/]+)/, entity: 'expense' },
  { pattern: /\/api\/expenses\/?$/, entity: 'expense' },

  { pattern: /\/api\/leave\/([^/]+)/, entity: 'leave_request' },
  { pattern: /\/api\/leave\/?$/, entity: 'leave_request' },

  { pattern: /\/api\/finished-goods\/([^/]+)/, entity: 'finished_goods' },
  { pattern: /\/api\/finished-goods\/?$/, entity: 'finished_goods' },

  { pattern: /\/api\/packing-inventory\/([^/]+)\/audit/, entity: 'packing_material', action: 'audit' },
  { pattern: /\/api\/packing-inventory\/deduct/, entity: 'packing_material', action: 'deduct' },
  { pattern: /\/api\/packing-inventory\/bulk-stock-count/, entity: 'packing_material', action: 'bulk_count' },
  { pattern: /\/api\/packing-inventory\/([^/]+)/, entity: 'packing_material' },
  { pattern: /\/api\/packing-inventory\/?$/, entity: 'packing_material' },

  { pattern: /\/api\/packing-procurement\/([^/]+)\/receive/, entity: 'packing_po', action: 'receive' },
  { pattern: /\/api\/packing-procurement\/([^/]+)\/mark-paid/, entity: 'packing_po', action: 'mark_paid' },
  { pattern: /\/api\/packing-procurement\/([^/]+)\/add-logistics/, entity: 'packing_po', action: 'add_logistics' },
  { pattern: /\/api\/packing-procurement\/([^/]+)/, entity: 'packing_po' },
  { pattern: /\/api\/packing-procurement\/?$/, entity: 'packing_po' },

  { pattern: /\/api\/raw-stock\/sync/, entity: 'raw_material', action: 'sync' },
  { pattern: /\/api\/raw-stock\/([^/]+)/, entity: 'raw_material' },
  { pattern: /\/api\/raw-stock\/?$/, entity: 'raw_material' },

  { pattern: /\/api\/blog\/wa-trigger/, entity: 'blog', action: 'wa_trigger' },
  { pattern: /\/api\/blog\/([^/]+)/, entity: 'blog_post' },
  { pattern: /\/api\/blog\/?$/, entity: 'blog_post' },

  { pattern: /\/api\/campaigns\/([^/]+)\/send/, entity: 'campaign', action: 'send' },
  { pattern: /\/api\/campaigns\/([^/]+)/, entity: 'campaign' },
  { pattern: /\/api\/campaigns\/?$/, entity: 'campaign' },

  { pattern: /\/api\/compliance\/([^/]+)\/done/, entity: 'compliance_item', action: 'mark_done' },
  { pattern: /\/api\/compliance\/([^/]+)/, entity: 'compliance_item' },
  { pattern: /\/api\/compliance\/?$/, entity: 'compliance_item' },

  { pattern: /\/api\/coupons\/([^/]+)\/redeem/, entity: 'coupon', action: 'redeem' },
  { pattern: /\/api\/coupons\/([^/]+)/, entity: 'coupon' },
  { pattern: /\/api\/coupons\/?$/, entity: 'coupon' },

  { pattern: /\/api\/credit-notes\/([^/]+)/, entity: 'credit_note' },
  { pattern: /\/api\/credit-notes\/?$/, entity: 'credit_note' },

  { pattern: /\/api\/delivery\/item\/([^/]+)/, entity: 'delivery_item' },
  { pattern: /\/api\/delivery\/([^/]+)/, entity: 'delivery' },
  { pattern: /\/api\/delivery\/?$/, entity: 'delivery' },

  { pattern: /\/api\/eway-bill\/generate/, entity: 'eway_bill', action: 'generate' },
  { pattern: /\/api\/eway-bill\/cancel/, entity: 'eway_bill', action: 'cancel' },
  { pattern: /\/api\/eway-bill\/update-vehicle/, entity: 'eway_bill', action: 'update_vehicle' },
  { pattern: /\/api\/eway-bill\/save-local/, entity: 'eway_bill', action: 'save_draft' },

  { pattern: /\/api\/gst-filing\/sync-invoices/, entity: 'gst_filing', action: 'sync_invoices' },
  { pattern: /\/api\/gst-filing\/prepare-gstr1/, entity: 'gst_filing', action: 'prepare_gstr1' },
  { pattern: /\/api\/gst-filing\/prepare-gstr3b/, entity: 'gst_filing', action: 'prepare_gstr3b' },
  { pattern: /\/api\/gst-filing\/file-gstr1/, entity: 'gst_filing', action: 'file_gstr1' },
  { pattern: /\/api\/gst-filing\/file-gstr3b/, entity: 'gst_filing', action: 'file_gstr3b' },
  { pattern: /\/api\/gst-filing\/challans\/([^/]+)/, entity: 'gst_challan' },
  { pattern: /\/api\/gst-filing\/challans\/?$/, entity: 'gst_challan' },

  { pattern: /\/api\/kiosk\/register-face/, entity: 'kiosk_employee' },
  { pattern: /\/api\/kiosk\/shift-config/, entity: 'kiosk_config' },

  { pattern: /\/api\/ledger\/petty-cash\/([^/]+)/, entity: 'petty_cash' },
  { pattern: /\/api\/ledger\/petty-cash\/?$/, entity: 'petty_cash' },
  { pattern: /\/api\/ledger\/([^/]+)/, entity: 'ledger_entry' },
  { pattern: /\/api\/ledger\/?$/, entity: 'ledger_entry' },

  { pattern: /\/api\/maintenance\/([^/]+)/, entity: 'maintenance' },
  { pattern: /\/api\/maintenance\/?$/, entity: 'maintenance' },

  { pattern: /\/api\/purchases\/([^/]+)/, entity: 'purchase' },
  { pattern: /\/api\/purchases\/?$/, entity: 'purchase' },

  { pattern: /\/api\/quality\/([^/]+)/, entity: 'quality_test' },
  { pattern: /\/api\/quality\/?$/, entity: 'quality_test' },

  { pattern: /\/api\/recurring-expenses\/([^/]+)\/pay/, entity: 'recurring_expense', action: 'pay' },
  { pattern: /\/api\/recurring-expenses\/([^/]+)/, entity: 'recurring_expense' },
  { pattern: /\/api\/recurring-expenses\/?$/, entity: 'recurring_expense' },

  { pattern: /\/api\/returns\/([^/]+)/, entity: 'return_request' },
  { pattern: /\/api\/returns\/?$/, entity: 'return_request' },

  { pattern: /\/api\/seed-lots\/([^/]+)\/finalize/, entity: 'seed_lot', action: 'finalize' },
  { pattern: /\/api\/seed-lots\/([^/]+)\/reopen/, entity: 'seed_lot', action: 'reopen' },
  { pattern: /\/api\/seed-lots\/([^/]+)\/entries\/([^/]+)/, entity: 'seed_lot' },
  { pattern: /\/api\/seed-lots\/([^/]+)\/entries/, entity: 'seed_lot' },

  { pattern: /\/api\/social\/posts\/([^/]+)\/publish/, entity: 'social_post', action: 'publish' },
  { pattern: /\/api\/social\/posts\/([^/]+)/, entity: 'social_post' },
  { pattern: /\/api\/social/, entity: 'social_content' },

  { pattern: /\/api\/stock-counts\/([^/]+)\/apply/, entity: 'stock_count', action: 'apply' },
  { pattern: /\/api\/stock-counts\/([^/]+)/, entity: 'stock_count' },
  { pattern: /\/api\/stock-counts\/?$/, entity: 'stock_count' },

  { pattern: /\/api\/tasks\/([^/]+)/, entity: 'task' },
  { pattern: /\/api\/tasks\/?$/, entity: 'task' },

  { pattern: /\/api\/wa-marketing\/broadcast/, entity: 'wa_broadcast', action: 'send' },
  { pattern: /\/api\/wa-marketing\/templates\/([^/]+)/, entity: 'wa_template' },
  { pattern: /\/api\/wa-marketing\/templates\/?$/, entity: 'wa_template' },
  { pattern: /\/api\/wa-marketing\/schedules\/([^/]+)/, entity: 'wa_schedule' },
  { pattern: /\/api\/wa-marketing\/schedules\/?$/, entity: 'wa_schedule' },
  { pattern: /\/api\/wa-marketing\/drips\/([^/]+)/, entity: 'wa_drip' },
  { pattern: /\/api\/wa-marketing\/drips\/?$/, entity: 'wa_drip' },

  { pattern: /\/api\/wa-catalog\/setup/, entity: 'wa_catalog', action: 'setup' },
  { pattern: /\/api\/wa-catalog\/sync/, entity: 'wa_catalog', action: 'sync' },
  { pattern: /\/api\/wa-catalog\/products\/([^/]+)/, entity: 'wa_catalog' },

  { pattern: /\/api\/payouts\/vendor-bill/, entity: 'payout', action: 'vendor_bill' },
  { pattern: /\/api\/payouts\/salary/, entity: 'payout', action: 'salary' },
  { pattern: /\/api\/payouts\/refund/, entity: 'payout', action: 'refund' },
  { pattern: /\/api\/payouts\/adhoc/, entity: 'payout', action: 'adhoc' },

  { pattern: /\/api\/whatsapp\/send/, entity: 'whatsapp_message', action: 'send' },
  { pattern: /\/api\/whatsapp\/scheduled/, entity: 'wa_scheduled_msg' },
  { pattern: /\/api\/whatsapp\/auto-assign-rules/, entity: 'wa_auto_assign' },
  { pattern: /\/api\/whatsapp\/conversations\/([^/]+)\/transfer/, entity: 'wa_conversation', action: 'transfer' },
  { pattern: /\/api\/whatsapp\/conversations\/([^/]+)\/csat/, entity: 'wa_conversation', action: 'send_csat' },
  { pattern: /\/api\/whatsapp\/bulk-action/, entity: 'wa_conversation', action: 'bulk_action' },
  { pattern: /\/api\/whatsapp\/messages\/([^/]+)\/forward/, entity: 'whatsapp_message', action: 'forward' },
  { pattern: /\/api\/whatsapp\/messages\/([^/]+)/, entity: 'whatsapp_message' },

  { pattern: /\/api\/auth\/webauthn\/register-verify/, entity: 'webauthn_credential', action: 'register' },
  { pattern: /\/api\/auth\/webauthn\/credentials\/([^/]+)/, entity: 'webauthn_credential' },
  { pattern: /\/api\/auth\/2fa\/setup/, entity: 'admin_2fa', action: 'setup' },
  { pattern: /\/api\/auth\/2fa\/confirm/, entity: 'admin_2fa', action: 'enable' },
  { pattern: /\/api\/auth\/2fa\/disable/, entity: 'admin_2fa', action: 'disable' },
  { pattern: /\/api\/auth\/change-password/, entity: 'admin_password', action: 'change' },

  { pattern: /\/api\/users\/([^/]+)/, entity: 'user' },
  { pattern: /\/api\/users\/?$/, entity: 'user' },

  { pattern: /\/api\/settings\/([^/]+)/, entity: 'setting' },
  { pattern: /\/api\/settings\/?$/, entity: 'setting' },

  { pattern: /\/api\/icici-bank/, entity: 'icici_bank_upload', action: 'upload' },

  { pattern: /\/api\/subscriptions/, entity: 'subscription' },
  { pattern: /\/api\/agent\/run/, entity: 'ai_ops_agent', action: 'run' },
  { pattern: /\/api\/security\/deploy-now/, entity: 'deploy', action: 'trigger' },
];

/* ─── Extract human-readable label from request body ─── */

const LABEL_FIELDS = [
  'order_no', 'orderNo', 'order_number',
  'name', 'title', 'subject',
  'commodity_name', 'commodityName', 'commodity',
  'product_name', 'productName',
  'username', 'company_name', 'companyName',
  'machine_name', 'machineName',
  'bill_no', 'billNo',
  'code', 'slug', 'key',
  'employee_name', 'employeeName',
  'description', 'narration',
];

function extractLabel(body) {
  if (!body || typeof body !== 'object') return null;
  for (const f of LABEL_FIELDS) {
    if (body[f] && typeof body[f] === 'string') return body[f].slice(0, 200);
  }
  // Nested: body.customer.name, body.items[0].name
  if (body.customer?.name) return body.customer.name;
  return null;
}

/* ─── Derive action from HTTP method ─── */

function deriveAction(method, routeAction) {
  if (routeAction) return routeAction;
  switch (method) {
    case 'POST':   return 'create';
    case 'PUT':    return 'update';
    case 'PATCH':  return 'update';
    case 'DELETE':  return 'delete';
    default:        return method.toLowerCase();
  }
}

/* ─── Build details string from body (sanitized — no passwords/secrets) ─── */

const SENSITIVE_KEYS = new Set([
  'password', 'password_hash', 'secret', 'totp_secret', 'token',
  'razorpay_signature', 'rawBody', 'creditCard', 'cvv',
]);

function buildDetails(body, method) {
  if (!body || typeof body !== 'object') return null;
  const safe = {};
  let count = 0;
  for (const [k, v] of Object.entries(body)) {
    if (count >= 15) break; // cap fields
    if (SENSITIVE_KEYS.has(k.toLowerCase())) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') safe[k] = v.length > 100 ? v.slice(0, 100) + '…' : v;
    else if (typeof v === 'number' || typeof v === 'boolean') safe[k] = v;
    else if (Array.isArray(v)) safe[k] = `[${v.length} items]`;
    else safe[k] = '{…}';
    count++;
  }
  return Object.keys(safe).length > 0 ? JSON.stringify(safe) : null;
}

/* ─── Main middleware ─── */

function auditLog(req, res, next) {
  if (!MUTATION_METHODS.has(req.method)) return next();

  const path = req.originalUrl || req.path;
  if (SKIP_PATHS.some(p => path.startsWith(p))) return next();

  res.on('finish', () => {
    // Only log authenticated admin requests
    if (!req.user) return;
    // Only log successful mutations (2xx, 3xx)
    if (res.statusCode >= 400) return;

    const ip =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;

    // 1. HTTP-level audit log (existing — column is `ts` not `created_at`)
    supabase.from('admin_audit_logs').insert({
      user_id:  String(req.user.id),
      username: req.user.username,
      role:     req.user.role,
      method:   req.method,
      path,
      status:   res.statusCode,
      ip,
      ts:       new Date().toISOString(),
    }).then(({ error }) => {
      if (error) console.error('[audit]', error.message);
    });

    // 2. Rich entity-level activity log
    let entityType = null;
    let entityId = null;
    let routeAction = null;

    for (const route of ROUTE_MAP) {
      const m = path.match(route.pattern);
      if (m) {
        entityType = route.entity;
        routeAction = route.action || null;
        entityId = m[1] || null; // first capture group = ID
        break;
      }
    }

    // Skip if we can't identify the entity (e.g. unknown/internal paths)
    if (!entityType) return;

    const action = deriveAction(req.method, routeAction);
    const label = extractLabel(req.body) || entityId || null;
    const details = buildDetails(req.body, req.method);

    supabase.from('user_activity_log').insert({
      user_id:      String(req.user.id),
      username:     req.user.username,
      action,
      entity_type:  entityType,
      entity_id:    entityId ? String(entityId) : null,
      entity_label: label ? String(label).slice(0, 200) : null,
      details,
      ip,
    }).then(({ error }) => {
      if (error) console.error('[activity]', error.message);
    });
  });

  next();
}

module.exports = auditLog;
