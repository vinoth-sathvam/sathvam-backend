const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');

const b2bCustomers = express.Router();
b2bCustomers.get('/', auth, async (req, res) => {
  const { data, error } = await supabase.from('b2b_customers').select('id,company_name,contact_name,email,country,currency,address,phone,active,registered_date').order('company_name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
b2bCustomers.post('/', auth, requireRole('admin'), async (req, res) => {
  const c = req.body;
  const hash = await bcrypt.hash(c.password || 'changeme123', 12);
  const { data, error } = await supabase.from('b2b_customers').insert({ company_name:c.companyName, contact_name:c.contactName, email:c.email, password:hash, country:c.country, currency:c.currency||'INR', address:c.address, phone:c.phone }).select('id,company_name,contact_name,email,country,active').single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

const b2bOrders = express.Router();
b2bOrders.get('/', auth, async (req, res) => {
  const { data, error } = await supabase.from('b2b_orders').select('*, b2b_order_items(*), b2b_order_stages(*)').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
b2bOrders.post('/', auth, async (req, res) => {
  const o = req.body;
  const { data: order, error } = await supabase.from('b2b_orders').insert({ order_no:o.orderNo, date:o.date, customer_id:o.customerId, buyer_name:o.buyerName, stage:o.stage||'order_placed', total_value:o.totalValue||0, notes:o.notes||'' }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  if (o.items && o.items.length) {
    await supabase.from('b2b_order_items').insert(o.items.map(i => ({ order_id:order.id, product_id:i.productId, product_name:i.productName, qty:i.qty, unit:i.unit||'pcs', unit_price:i.unitPrice, currency:i.currency||'INR', notes:i.notes||'' })));
  }
  await supabase.from('b2b_order_stages').insert({ order_id:order.id, stage:'order_placed', date:o.date, note:'Order placed', updated_by:req.user ? req.user.name : 'System' });
  res.status(201).json(order);
});
b2bOrders.put('/:id/stage', auth, async (req, res) => {
  const { stage, note, date, blNo, containerNo } = req.body;
  const updates = { stage };
  if (blNo) updates.bl_no = blNo;
  if (containerNo) updates.container_no = containerNo;
  const { data, error } = await supabase.from('b2b_orders').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  await supabase.from('b2b_order_stages').insert({ order_id:req.params.id, stage, date:date||new Date().toISOString().slice(0,10), note:note||('Stage: '+stage), updated_by:req.user ? req.user.name : 'Admin' });
  res.json(data);
});
b2bOrders.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const o = req.body;
  const { data, error } = await supabase.from('b2b_orders').update({ stage:o.stage, notes:o.notes, bl_no:o.blNo, container_no:o.containerNo, etd:o.etd, eta:o.eta }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});
b2bOrders.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  await supabase.from('b2b_order_items').delete().eq('order_id', req.params.id);
  await supabase.from('b2b_order_stages').delete().eq('order_id', req.params.id);
  await supabase.from('b2b_orders').delete().eq('id', req.params.id);
  res.json({ message: 'Deleted' });
});

const projects = express.Router();
projects.get('/', auth, async (req, res) => {
  const { data, error } = await supabase.from('projects').select('*, project_items(*), project_expenses(*)').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
projects.post('/', auth, requireRole('admin','manager'), async (req, res) => {
  const p = req.body;
  const { data: proj, error } = await supabase.from('projects').insert({ project_name:p.projectName, b2b_order_id:p.b2bOrderId||null, buyer_name:p.buyerName, buyer_country:p.buyerCountry, port_of_loading:p.portOfLoading, port_of_discharge:p.portOfDischarge, final_destination:p.finalDestination, pi_no:p.piNo, pi_date:p.piDate, status:p.status||'planning', notes:p.notes||'' }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(proj);
});
projects.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const p = req.body;
  const { data, error } = await supabase.from('projects').update({ project_name:p.projectName, status:p.status, bl_no:p.blNo, container_no:p.containerNo, etd:p.etd, mfg_invoice_no:p.mfgInvoiceNo, notes:p.notes }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});
projects.post('/:id/expenses', auth, async (req, res) => {
  const e = req.body;
  const { data, error } = await supabase.from('project_expenses').insert({ project_id:req.params.id, date:e.date, category:e.category, subcategory:e.subcategory, description:e.description, vendor:e.vendor, qty:e.qty||1, unit:e.unit, unit_cost:e.unitCost, total_cost:e.totalCost, paid_by:e.paidBy, stage:e.stage }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = { b2bCustomers, b2bOrders, projects };
