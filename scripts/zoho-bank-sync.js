#!/usr/bin/env node
/**
 * Zoho Bank Sync — automated timer script
 * Runs every 15 minutes via systemd timer.
 * Syncs last 7 days of bank transactions (categorized + uncategorized) from Zoho Books.
 */

const _rawUrl = process.env.SUPABASE_URL || '';
const _isLocal = _rawUrl.includes('postgrest:') || _rawUrl.includes('localhost:3100') || _rawUrl.includes('127.0.0.1:3100');
const _restPrefix = _isLocal ? '' : '/rest/v1';
const { PostgrestClient } = require('@supabase/postgrest-js');
const supabase = new PostgrestClient((_isLocal ? _rawUrl.replace(/\/+$/, '') : _rawUrl) + _restPrefix, {
  headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` },
});

const { zoho: zohoApi } = require('../config/zoho');

const ZOHO_ORG = () => process.env.ZOHO_ORG_ID;
const round2 = n => Math.round(n * 100) / 100;

async function main() {
  if (!zohoApi) { console.error('Zoho not configured'); process.exit(1); }

  // Get bank account with Zoho ID
  const { data: accounts } = await supabase.from('bank_accounts').select('id, zoho_account_id, name').eq('is_active', true);
  if (!accounts || !accounts.length) { console.log('No active bank accounts'); process.exit(0); }

  const synced = accounts.filter(a => a.zoho_account_id);
  if (!synced.length) { console.log('No bank accounts linked to Zoho'); process.exit(0); }

  const toDate = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  for (const acct of synced) {
    console.log(`\nSyncing: ${acct.name} (zoho: ${acct.zoho_account_id})`);
    let inserted = 0, updated = 0, skipped = 0;

    const processTxns = async (txns) => {
      for (const t of txns) {
        const zohoTxnId = t.transaction_id;
        const amount = round2(Math.abs(parseFloat(t.amount) || 0));
        if (amount <= 0) { skipped++; continue; }

        const desc = (t.payee || t.description || '').trim();
        const ref = (t.reference_number || '').trim();
        const isRealBankTxn = ref.length > 0 || /^(UPI|NEFT|RTGS|INF|MMT|ACH|BIL|MIN|MSI|EZY|Mob alrt|CAM|SMS|Dbt card|Cash dep|POSDEC)/i.test(desc);
        const isTrustedSource = t.source === 'bank_feed' || t.source === 'manually_added' || t.source === 'categorized' || t.source === 'matched';
        if (!isRealBankTxn && !isTrustedSource) { skipped++; continue; }

        const rec = {
          bank_account_id: acct.id, date: t.date,
          type: t.debit_or_credit === 'debit' ? 'credit' : 'debit',
          amount, description: desc || ref || '', reference: ref || t.transaction_id || '',
          category: t.category_name || t.account_name || '',
          zoho_txn_id: zohoTxnId,
          reconciled: t.status === 'manually_added' || t.status === 'matched' || t.status === 'categorized',
          created_by: 'zoho-auto-sync',
        };

        const { data: existing } = await supabase.from('bank_transactions').select('id').eq('zoho_txn_id', zohoTxnId).maybeSingle();
        if (existing) {
          await supabase.from('bank_transactions').update({ ...rec, updated_at: new Date().toISOString() }).eq('id', existing.id);
          updated++;
        } else {
          const { data: dupeMatches } = await supabase.from('bank_transactions')
            .select('id, zoho_txn_id, description')
            .eq('bank_account_id', acct.id).eq('date', rec.date).eq('type', rec.type)
            .gte('amount', rec.amount - 1).lte('amount', rec.amount + 1);
          const csvMatch = (dupeMatches || []).find(m => !m.zoho_txn_id) || (dupeMatches || [])[0];
          if (csvMatch) {
            const uf = { zoho_txn_id: zohoTxnId, reconciled: rec.reconciled, updated_at: new Date().toISOString() };
            if (!csvMatch.zoho_txn_id && rec.description) uf.description = rec.description;
            await supabase.from('bank_transactions').update(uf).eq('id', csvMatch.id);
            updated++;
          } else {
            await supabase.from('bank_transactions').insert(rec);
            inserted++;
          }
        }
      }
    };

    // Pass 1: categorized transactions
    let page = 1;
    while (true) {
      const data = await zohoApi('get', '/banktransactions', null, {
        organization_id: ZOHO_ORG(), account_id: acct.zoho_account_id,
        date_start: fromDate, date_end: toDate, page, per_page: 200,
        sort_column: 'date', sort_order: 'D',
      });
      const txns = data.banktransactions || [];
      if (!txns.length) break;
      await processTxns(txns);
      if (!data.page_context?.has_more_page) break;
      page++; if (page > 20) break;
    }

    // Pass 2: uncategorized bank feed entries
    page = 1;
    while (true) {
      const data = await zohoApi('get', '/banktransactions', null, {
        organization_id: ZOHO_ORG(), account_id: acct.zoho_account_id,
        date_start: fromDate, date_end: toDate, page, per_page: 200,
        sort_column: 'date', sort_order: 'D',
        filter_by: 'Status.Uncategorized',
      });
      const txns = data.banktransactions || [];
      if (!txns.length) break;
      await processTxns(txns);
      if (!data.page_context?.has_more_page) break;
      page++; if (page > 20) break;
    }

    // Update balance from Zoho
    try {
      const acctData = await zohoApi('get', `/bankaccounts/${acct.zoho_account_id}`, null, { organization_id: ZOHO_ORG() });
      const zohoBalance = parseFloat(acctData?.bankaccount?.bank_balance ?? acctData?.bankaccount?.balance) || null;
      if (zohoBalance !== null) {
        await supabase.from('bank_accounts')
          .update({ current_balance: round2(zohoBalance), zoho_synced_at: new Date().toISOString() })
          .eq('id', acct.id);
      }
      console.log(`  Balance: ₹${zohoBalance}`);
    } catch (e) { console.error('  Balance update failed:', e.message); }

    console.log(`  Inserted: ${inserted}, Updated: ${updated}, Skipped: ${skipped}`);
  }

  console.log('\nDone.');
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
