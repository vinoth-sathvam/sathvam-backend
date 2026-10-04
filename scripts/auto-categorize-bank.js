#!/usr/bin/env node
/**
 * Auto-categorize bank transactions based on description patterns.
 * Matches against vendor names, known payment patterns, and counterparty extraction.
 *
 * Usage: node scripts/auto-categorize-bank.js [--dry-run]
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const supabase = require('../config/supabase');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Category rules (order matters — first match wins) ──────────────────────

const DEBIT_RULES = [
  // Vendor payments (procurement)
  { match: /balamurugan|sri balamurugan/i, category: 'Vendor Payment', subcategory: 'Sri Balamurugan Mill', type: 'procurement' },
  { match: /new\s*india|newindia/i, category: 'Vendor Payment', subcategory: 'New India Traders', type: 'procurement' },
  { match: /kaarmegam/i, category: 'Vendor Payment', subcategory: 'Kaarmegam Oil', type: 'procurement' },
  { match: /selvakuppanna/i, category: 'Vendor Payment', subcategory: 'Sri Selvakuppanna Oil Mill', type: 'procurement' },
  { match: /gt\s*store|gtstoresalem/i, category: 'Vendor Payment', subcategory: 'GT Store Salem', type: 'procurement' },
  { match: /chitra\s*&?\s*co/i, category: 'Vendor Payment', subcategory: 'Chitra & Co', type: 'procurement' },
  { match: /sri\s*kamachi/i, category: 'Vendor Payment', subcategory: 'Sri Kamachi Amman', type: 'procurement' },
  { match: /raja\s*farms/i, category: 'Vendor Payment', subcategory: 'Raja Farms', type: 'procurement' },
  { match: /sivalaya/i, category: 'Vendor Payment', subcategory: 'Sivalaya Traders', type: 'procurement' },
  { match: /kanaga\s*dhenu/i, category: 'Vendor Payment', subcategory: 'Sri Kanaga Dhenu', type: 'procurement' },
  { match: /bishnoi\s*village/i, category: 'Vendor Payment', subcategory: 'Bishnoi Village Craft', type: 'procurement' },
  { match: /cosmos\s*pack/i, category: 'Vendor Payment', subcategory: 'Cosmos Packware', type: 'packaging' },
  { match: /karan\s*plast/i, category: 'Vendor Payment', subcategory: 'Karan Plastics', type: 'packaging' },
  { match: /interglobal|ilogis/i, category: 'Vendor Payment', subcategory: 'Interglobal Logistics', type: 'logistics' },
  { match: /nikhilpandya/i, category: 'Vendor Payment', subcategory: 'Nikhil Pandya', type: 'service' },
  { match: /zezugraphics/i, category: 'Vendor Payment', subcategory: 'Zezugraphics', type: 'design' },
  { match: /ss\s*systems/i, category: 'Vendor Payment', subcategory: 'SS Systems', type: 'it' },

  // Software & subscriptions
  { match: /anthropic/i, category: 'Software', subcategory: 'Anthropic (AI)', type: 'subscription' },
  { match: /supabase/i, category: 'Software', subcategory: 'Supabase', type: 'subscription' },
  { match: /sqsp\s*works|sqsp\s*domai/i, category: 'Software', subcategory: 'Squarespace', type: 'subscription' },
  { match: /facebook\s*in/i, category: 'Marketing', subcategory: 'Facebook Ads', type: 'advertising' },
  { match: /google\s*india/i, category: 'Software', subcategory: 'Google', type: 'subscription' },
  { match: /paypro\s*glob/i, category: 'Software', subcategory: 'PayPro', type: 'subscription' },
  { match: /viltd/i, category: 'Software', subcategory: 'VILTD', type: 'subscription' },
  { match: /swiggy/i, category: 'Food & Meals', subcategory: 'Swiggy', type: 'expense' },

  // Bank charges
  { match: /mob\s*alrt\s*chg|sms\s*chrg|cash\s*dep\s*chg|dbt\s*card\s*chg|posdec\s*chg|nmmab\s*chrg/i, category: 'Bank Charges', subcategory: 'Service Charges', type: 'bank' },
  { match: /gst$/i, category: 'Bank Charges', subcategory: 'GST on Charges', type: 'bank' },

  // Utilities & government
  { match: /tamilnadu\s*electri|tneb|bil\/onl/i, category: 'Utilities', subcategory: 'Electricity', type: 'utility' },

  // Internal transfers (self transfers between accounts)
  { match: /sathvamoilsands|sathvam\s*oils?\s*and/i, category: 'Internal Transfer', subcategory: 'Between Own Accounts', type: 'transfer' },
  { match: /inf\/inft|inf\/neft.*vinothy/i, category: 'Internal Transfer', subcategory: 'Between Own Accounts', type: 'transfer' },

  // Employee payments
  { match: /ramathamal/i, category: 'Salary', subcategory: 'Ramathamal', type: 'payroll' },
  { match: /udaya\s*manivel/i, category: 'Salary', subcategory: 'Udaya Manivel', type: 'payroll' },
  { match: /murugasan/i, category: 'Salary', subcategory: 'Murugasan K', type: 'payroll' },
  { match: /manimegalai/i, category: 'Salary', subcategory: 'Manimegalai', type: 'payroll' },
  { match: /vanmathy/i, category: 'Salary', subcategory: 'Vanmathy V', type: 'payroll' },
  { match: /nivetha\s*raju/i, category: 'Salary', subcategory: 'Nivetha Raju', type: 'payroll' },
  { match: /amasa/i, category: 'Salary', subcategory: 'Amasa', type: 'payroll' },

  // Insurance
  { match: /sree\s*jayanathan|ach\/sree/i, category: 'Insurance', subcategory: 'Sree Jayanathan Chit', type: 'insurance' },

  // Cash withdrawal
  { match: /nfs\/cash\s*wdl|atm|cam\/.*cash\s*wdl/i, category: 'Cash Withdrawal', subcategory: 'ATM/Cash', type: 'cash' },

  // Additional vendors from unmatched
  { match: /shriabinay|abinay/i, category: 'Vendor Payment', subcategory: 'Shri Abinay', type: 'service' },
  { match: /karuppia/i, category: 'Vendor Payment', subcategory: 'Karuppiahr', type: 'service' },
  { match: /tsuresh|t\s*suresh/i, category: 'Vendor Payment', subcategory: 'T Suresh', type: 'service' },
  { match: /tamil\s*nadu\s*\/|tneb/i, category: 'Utilities', subcategory: 'Tamil Nadu Electricity', type: 'utility' },
  { match: /pay\s*www\s*swi/i, category: 'Software', subcategory: 'Swiggy/Web', type: 'subscription' },
  { match: /ecsrtn/i, category: 'Bank Charges', subcategory: 'ECS Return', type: 'bank' },
  { match: /ezy\/upiccmdr/i, category: 'Bank Charges', subcategory: 'UPI AutoPay', type: 'bank' },
  { match: /sathvamhdfc|sathvam.*hdfc/i, category: 'Internal Transfer', subcategory: 'Between Own Accounts', type: 'transfer' },

  // UPI — general (last resort for debits)
  { match: /upi\//i, category: 'UPI Payment', subcategory: 'Miscellaneous', type: 'upi' },
  // IMPS — general (last resort)
  { match: /mmt\/imps/i, category: 'Miscellaneous Payment', subcategory: 'IMPS Transfer', type: 'misc' },
];

const CREDIT_RULES = [
  // B2B customer payments
  { match: /sri\s*mrb|mrb\s*traders/i, category: 'B2B Payment', subcategory: 'Sri MRB Traders (Malaysia)', type: 'b2b_revenue' },
  { match: /yuvarajan/i, category: 'B2B Payment', subcategory: 'Yuvarajan P', type: 'b2b_revenue' },

  // Own account transfers
  { match: /sathvam\s*oils|sathvamoils/i, category: 'Internal Transfer', subcategory: 'From Own Account', type: 'transfer' },
  { match: /inf\/inft|inf\/neft.*vinothy/i, category: 'Internal Transfer', subcategory: 'From Own Account', type: 'transfer' },

  // Razorpay (webstore sales)
  { match: /razorpay/i, category: 'Webstore Sales', subcategory: 'Razorpay Settlement', type: 'revenue' },

  // Cash deposits
  { match: /cam\/|cash\s*dep/i, category: 'Cash Deposit', subcategory: 'Cash Deposit', type: 'cash_in' },

  // UPI credits (POS/direct sales)
  { match: /upi\//i, category: 'Direct Payment', subcategory: 'UPI Received', type: 'revenue' },

  // IMPS
  { match: /mmt\/imps.*rda/i, category: 'B2B Payment', subcategory: 'Foreign Inward (RDA)', type: 'b2b_revenue' },
  { match: /mmt\/imps/i, category: 'Direct Payment', subcategory: 'IMPS Received', type: 'revenue' },

  // NEFT/RTGS (general)
  { match: /neft|rtgs/i, category: 'Direct Payment', subcategory: 'Bank Transfer Received', type: 'revenue' },

  // Refunds
  { match: /mcd\s*ref|refund/i, category: 'Refund', subcategory: 'Ad Refund', type: 'refund' },
  { match: /ecsrtn/i, category: 'Refund', subcategory: 'ECS Return', type: 'refund' },
];

async function main() {
  console.log(`[Auto-Categorize] ${DRY_RUN ? 'DRY RUN — no changes' : 'LIVE — will update DB'}\n`);

  // Load all transactions
  const { data: txns, error } = await supabase.from('bank_transactions')
    .select('id,date,type,amount,description,category,reference')
    .order('date', { ascending: false })
    .limit(5000);

  if (error) { console.error('Failed to load transactions:', error.message); return; }
  console.log(`Loaded ${txns.length} transactions`);

  // Also load vendor names for dynamic matching
  const { data: vendors } = await supabase.from('vendors').select('display_name,company_name').limit(500);
  const vendorPatterns = (vendors || [])
    .map(v => (v.display_name || v.company_name || '').trim())
    .filter(n => n.length > 4) // skip very short names
    .map(n => ({ match: new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), category: 'Vendor Payment', subcategory: n, type: 'procurement' }));

  let updated = 0, skipped = 0, unchanged = 0;
  const catSummary = {};

  for (const txn of txns) {
    const desc = txn.description || '';
    const rules = txn.type === 'debit' ? [...DEBIT_RULES, ...vendorPatterns] : CREDIT_RULES;

    let matched = null;
    for (const rule of rules) {
      if (rule.match.test(desc)) { matched = rule; break; }
    }

    if (!matched) {
      skipped++;
      continue;
    }

    const newCategory = matched.category;
    const oldCategory = txn.category || '';

    // Skip if already correctly categorized
    if (oldCategory === newCategory) { unchanged++; continue; }

    const key = `${newCategory} → ${matched.subcategory}`;
    catSummary[key] = (catSummary[key] || { count: 0, amount: 0 });
    catSummary[key].count++;
    catSummary[key].amount += parseFloat(txn.amount) || 0;

    if (!DRY_RUN) {
      const { error: upErr } = await supabase.from('bank_transactions')
        .update({
          category: newCategory,
          updated_at: new Date().toISOString(),
        })
        .eq('id', txn.id);
      if (upErr) console.error(`  Failed to update txn ${txn.id}:`, upErr.message);
    }
    updated++;
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Updated: ${updated}`);
  console.log(`Already correct: ${unchanged}`);
  console.log(`Unmatched (skipped): ${skipped}`);

  console.log(`\n--- CATEGORY BREAKDOWN ---`);
  Object.entries(catSummary)
    .sort((a, b) => b[1].amount - a[1].amount)
    .forEach(([cat, { count, amount }]) => {
      console.log(`  ${count}x  ₹${Math.round(amount).toLocaleString('en-IN').padStart(12)}  ${cat}`);
    });

  if (skipped > 0) {
    console.log(`\n--- UNMATCHED TRANSACTIONS (${skipped}) ---`);
    txns.filter(t => {
      const desc = t.description || '';
      const rules = t.type === 'debit' ? [...DEBIT_RULES, ...vendorPatterns] : CREDIT_RULES;
      return !rules.some(r => r.match.test(desc));
    }).slice(0, 15).forEach(t => {
      console.log(`  ${t.type} ₹${parseFloat(t.amount).toLocaleString('en-IN')} ${t.date} "${(t.description || '').slice(0, 60)}"`);
    });
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
