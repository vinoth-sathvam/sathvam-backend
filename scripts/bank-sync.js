#!/usr/bin/env node
/**
 * Automated Zoho Bank Sync
 * Syncs last 7 days of bank transactions from Zoho Books → local DB
 * Runs daily via systemd timer: sathvam-bank-sync.timer
 */

const ZOHO_ACCOUNT_ID = '1247318000000189051';
const LOCAL_ACCOUNT_ID = 1;

// ── Supabase (PostgREST) ────────────────────────────────────────────────────
const _rawUrl = process.env.SUPABASE_URL || '';
const _isLocal = _rawUrl.includes('postgrest:') || _rawUrl.includes('localhost:3100') || _rawUrl.includes('127.0.0.1:3100');
const _restPrefix = _isLocal ? '' : '/rest/v1';
const _restUrl = _rawUrl.replace(/\/+$/, '') + _restPrefix;
const { PostgrestClient } = require('@supabase/postgrest-js');
const supabase = new PostgrestClient(_restUrl, {
  headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` },
});

// ── Zoho API ────────────────────────────────────────────────────────────────
const axios = require('axios');
const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_ORG_ID        = process.env.ZOHO_ORG_ID;

let zohoToken = null;
let tokenExpires = 0;

async function getZohoToken() {
  if (zohoToken && Date.now() < tokenExpires) return zohoToken;
  const { data } = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: { refresh_token: ZOHO_REFRESH_TOKEN, client_id: ZOHO_CLIENT_ID, client_secret: ZOHO_CLIENT_SECRET, grant_type: 'refresh_token' },
  });
  zohoToken = data.access_token;
  tokenExpires = Date.now() + 3500000; // ~58 min
  return zohoToken;
}

async function zohoGet(path, params = {}) {
  const token = await getZohoToken();
  const { data } = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: ZOHO_ORG_ID, ...params },
  });
  return data;
}

// ── WhatsApp notification ───────────────────────────────────────────────────
async function sendWA(msg) {
  const instId = process.env.GREENAPI_INSTANCE_ID;
  const token  = process.env.GREENAPI_API_TOKEN;
  const phone  = process.env.WA_ADMIN_PHONE1;
  if (!instId || !token || !phone) return;
  const chatId = (phone.length === 10 ? '91' + phone : phone) + '@c.us';
  try {
    await axios.post(`https://api.green-api.com/waInstance${instId}/sendMessage/${token}`, { chatId, message: msg });
  } catch (e) { console.error('[WA]', e.message); }
}

const round2 = n => Math.round((parseFloat(n) || 0) * 100) / 100;

async function run() {
  console.log('[bank-sync] Starting Zoho bank sync...');

  if (!ZOHO_CLIENT_ID || !ZOHO_REFRESH_TOKEN || !ZOHO_ORG_ID) {
    console.error('[bank-sync] FATAL: Zoho credentials not configured');
    process.exit(1);
  }

  const fromDate = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const toDate   = new Date().toISOString().slice(0, 10);
  console.log(`[bank-sync] Period: ${fromDate} to ${toDate}`);

  let page = 1, inserted = 0, updated = 0, skipped = 0;

  while (true) {
    const data = await zohoGet('/banktransactions', {
      account_id: ZOHO_ACCOUNT_ID,
      date_start: fromDate,
      date_end:   toDate,
      page,
      per_page:   200,
      sort_column: 'date',
      sort_order:  'D',
    });

    const txns = data.banktransactions || [];
    if (!txns.length) break;

    for (const t of txns) {
      const zohoTxnId = t.transaction_id;
      const amount = round2(Math.abs(parseFloat(t.amount) || 0));
      if (amount <= 0) { skipped++; continue; }

      const desc = (t.payee || t.description || '').trim();
      const ref  = (t.reference_number || '').trim();
      const isRealBankTxn = ref.length > 0 || /^(UPI|NEFT|RTGS|INF|MMT|ACH|BIL|MIN|MSI|EZY|Mob alrt)/i.test(desc);
      if (!isRealBankTxn && t.source !== 'bank_feed') { skipped++; continue; }

      const rec = {
        bank_account_id: LOCAL_ACCOUNT_ID,
        date:            t.date,
        type:            t.debit_or_credit === 'credit' ? 'credit' : 'debit',
        amount,
        description:     desc || ref || '',
        reference:       ref || t.transaction_id || '',
        category:        t.category_name || t.account_name || '',
        zoho_txn_id:     zohoTxnId,
        reconciled:      t.status === 'manually_added' || t.status === 'matched' || t.status === 'categorized',
        created_by:      'zoho-bank-sync',
      };

      // Check existing by zoho_txn_id
      const { data: existing } = await supabase
        .from('bank_transactions').select('id').eq('zoho_txn_id', zohoTxnId).maybeSingle();

      if (existing) {
        await supabase.from('bank_transactions')
          .update({ ...rec, updated_at: new Date().toISOString() }).eq('id', existing.id);
        updated++;
      } else {
        // Dedup: match by account + date + type + amount (±₹1)
        const { data: dupes } = await supabase
          .from('bank_transactions').select('id, zoho_txn_id, description')
          .eq('bank_account_id', LOCAL_ACCOUNT_ID).eq('date', rec.date).eq('type', rec.type)
          .gte('amount', rec.amount - 1).lte('amount', rec.amount + 1);

        const match = (dupes || []).find(m => !m.zoho_txn_id) || (dupes || [])[0];
        if (match) {
          const upd = { zoho_txn_id: zohoTxnId, reconciled: rec.reconciled, updated_at: new Date().toISOString() };
          if (!match.zoho_txn_id && rec.description) upd.description = rec.description;
          await supabase.from('bank_transactions').update(upd).eq('id', match.id);
          updated++;
        } else {
          await supabase.from('bank_transactions').insert(rec);
          inserted++;
        }
      }
    }

    if (!data.page_context?.has_more_page) break;
    page++;
    if (page > 20) break;
  }

  // Update bank balance from Zoho
  let newBalance = null;
  try {
    const acctData = await zohoGet(`/bankaccounts/${ZOHO_ACCOUNT_ID}`);
    newBalance = parseFloat(acctData?.bankaccount?.bank_balance ?? acctData?.bankaccount?.balance) || null;
    if (newBalance !== null) {
      await supabase.from('bank_accounts')
        .update({ current_balance: round2(newBalance), zoho_synced_at: new Date().toISOString() })
        .eq('id', LOCAL_ACCOUNT_ID);
    }
  } catch (e) { console.warn('[bank-sync] Balance update failed:', e.message); }

  const summary = `[bank-sync] Done: ${inserted} new, ${updated} updated, ${skipped} skipped${newBalance !== null ? `, balance ₹${round2(newBalance).toLocaleString('en-IN')}` : ''}`;
  console.log(summary);

  // WA notification only if new transactions found
  if (inserted > 0) {
    await sendWA(`🏦 Bank Sync Complete\n${inserted} new transactions synced\n${updated} updated\nPeriod: ${fromDate} → ${toDate}${newBalance !== null ? `\nBalance: ₹${round2(newBalance).toLocaleString('en-IN')}` : ''}`);
  }
}

run().catch(e => {
  console.error('[bank-sync] FATAL:', e.message);
  sendWA(`❌ Bank Sync Failed: ${e.message}`).finally(() => process.exit(1));
});
