const supabaseUrl = process.env.SUPABASE_URL || '';

if (supabaseUrl.includes('supabase.co')) {
  // Managed Supabase
  const { createClient } = require('@supabase/supabase-js');
  module.exports = createClient(
    supabaseUrl,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
} else {
  // Self-hosted PostgREST — use PostgrestClient directly
  const { PostgrestClient } = require('@supabase/postgrest-js');
  const client = new PostgrestClient(supabaseUrl, {
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      apikey: process.env.SUPABASE_SERVICE_KEY,
    },
  });
  module.exports = { from: client.from.bind(client) };
}
