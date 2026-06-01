/**
 * utils/ledger.js
 * Shared helper — insert a row into money_ledger from any route.
 * Swallows errors so it never breaks the calling transaction.
 */
const supabase = require('../config/supabase');

/**
 * @param {Object} data
 * @param {string}  data.txn_date       YYYY-MM-DD
 * @param {'in'|'out'} data.direction
 * @param {number}  data.amount
 * @param {string}  data.category       sales | expense | payroll | procurement | bank_transfer | petty_cash | gst | tds | loan | other
 * @param {string}  [data.subcategory]
 * @param {string}  [data.party]
 * @param {string}  [data.party_type]   customer | vendor | employee | bank | govt | other
 * @param {string}  [data.payment_mode] cash | bank_transfer | upi | cheque | card | neft | rtgs
 * @param {string}  [data.narration]
 * @param {string}  [data.reference_no]
 * @param {string}  [data.source_table]
 * @param {string}  [data.source_id]
 * @param {number}  [data.gst_amount]
 * @param {number}  [data.tds_amount]
 * @param {string}  [data.created_by]
 */
async function insertLedger(data) {
  try {
    await supabase.from('money_ledger').insert({
      txn_date:     data.txn_date,
      direction:    data.direction,
      amount:       parseFloat(data.amount) || 0,
      category:     data.category || 'other',
      subcategory:  data.subcategory  || '',
      party:        data.party        || '',
      party_type:   data.party_type   || 'other',
      payment_mode: data.payment_mode || 'bank_transfer',
      narration:    data.narration    || '',
      reference_no: data.reference_no || '',
      source_table: data.source_table || '',
      source_id:    data.source_id    || '',
      gst_amount:   parseFloat(data.gst_amount)  || 0,
      tds_amount:   parseFloat(data.tds_amount)  || 0,
      created_by:   data.created_by   || '',
    });
  } catch (e) {
    console.error('[LEDGER] insert error:', e.message);
  }
}

module.exports = { insertLedger };
