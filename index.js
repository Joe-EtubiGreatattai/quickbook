// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const OAuthClient = require('intuit-oauth');

const app = express();
app.use(bodyParser.json());

const {
  PORT = 3000,
  QBO_CLIENT_ID,
  QBO_CLIENT_SECRET,
  QBO_REDIRECT_URI,
  QBO_ENV = 'sandbox',
} = process.env;

if (!QBO_CLIENT_ID || !QBO_CLIENT_SECRET || !QBO_REDIRECT_URI) {
  console.error('Missing env vars. Check .env');
  process.exit(1);
}

const oauthClient = new OAuthClient({
  clientId: QBO_CLIENT_ID,
  clientSecret: QBO_CLIENT_SECRET,
  environment: QBO_ENV === 'production' ? 'production' : 'sandbox',
  redirectUri: QBO_REDIRECT_URI,
});

// Only keep realmId here. Tokens live inside oauthClient.
let store = { realmId: null };

function requireAuth(req, res, next) {
  const hasToken = typeof oauthClient.getToken === 'function' && oauthClient.getToken();
  if (!store.realmId || !hasToken) {
    return res.status(401).json({ error: 'Not connected to QuickBooks. Visit /auth/connect first.' });
  }
  next();
}

async function ensureAccessToken() {
  const tokenObj = oauthClient.getToken && oauthClient.getToken();
  if (!tokenObj) throw new Error('Not authenticated');

  if (!oauthClient.isAccessTokenValid()) {
    await oauthClient.refresh();
  }
  const tokenJson = oauthClient.getToken().getToken();
  return tokenJson.access_token;
}

function apiBase() {
  const host =
    QBO_ENV === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';
  return `${host}/v3/company/${store.realmId}`;
}

// Health
app.get('/', (req, res) => {
  res.json({ ok: true, connected: Boolean(store.realmId) });
});

// Start OAuth
app.get('/auth/connect', (req, res) => {
  console.log('Using redirectUri:', oauthClient.redirectUri);
  const authUri = oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state: 'state-' + Math.random().toString(36).slice(2),
  });
  console.log('Auth URL:', authUri);
  res.redirect(authUri);
});

// OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { code, realmId, error, error_description } = req.query || {};
  console.log('QB callback:', req.query);
  if (error) return res.status(400).send(`OAuth error: ${error} ${error_description || ''}`);
  if (!code || !realmId) return res.status(400).send('Missing code/realmId. Start at /auth/connect.');
  try {
    await oauthClient.createToken(req.originalUrl || req.url); // sets token internally
    store.realmId = realmId;
    return res.send('Connected. Use /invoices endpoints.');
  } catch (e) {
    console.error('Token exchange failed:', e.response?.data || e.message);
    return res.status(400).send('Token exchange failed.');
  }
});

/* =========================
   Invoice CRUD-lite
   ========================= */

// Create invoice
app.post('/invoices', requireAuth, async (req, res) => {
  try {
    const accessToken = await ensureAccessToken();
    const url = `${apiBase()}/invoice?minorversion=73`;
    const { data } = await axios.post(url, req.body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    res.status(201).json(data);
  } catch (err) {
    const msg = err.response?.data || { error: err.message };
    res.status(400).json(msg);
  }
});

// Get invoice by Id
app.get('/invoices/:id', requireAuth, async (req, res) => {
  try {
    const accessToken = await ensureAccessToken();
    const url = `${apiBase()}/invoice/${encodeURIComponent(req.params.id)}?minorversion=73`;
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    res.json(data);
  } catch (err) {
    const msg = err.response?.data || { error: err.message };
    res.status(400).json(msg);
  }
});

// List invoices
app.get('/invoices', requireAuth, async (req, res) => {
  try {
    const start = Number(req.query.start || 1);
    const max = Math.min(Number(req.query.max || 50), 100);
    const q = `select * from Invoice startposition ${start} maxresults ${max}`;
    const accessToken = await ensureAccessToken();
    const url = `${apiBase()}/query?minorversion=73&query=${encodeURIComponent(q)}`;
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    res.json(data);
  } catch (err) {
    const msg = err.response?.data || { error: err.message };
    res.status(400).json(msg);
  }
});

/* =========================
   New: PDF download + Email
   ========================= */

// Download invoice PDF
app.get('/invoices/:id/pdf', requireAuth, async (req, res) => {
  try {
    const accessToken = await ensureAccessToken();
    const url = `${apiBase()}/invoice/${encodeURIComponent(req.params.id)}/pdf?minorversion=73`;
    const pdf = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/pdf' },
      responseType: 'arraybuffer',
      validateStatus: s => s >= 200 && s < 300, // ensure errors fall to catch with body
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=invoice-${req.params.id}.pdf`);
    res.send(Buffer.from(pdf.data));
  } catch (err) {
    // Try to surface JSON error if any
    const data = err.response?.data;
    let body = { error: err.message };
    try {
      if (data && typeof data !== 'string') body = data;
      else if (data && typeof data === 'string') body = JSON.parse(data);
    } catch (_) {}
    res.status(err.response?.status || 400).json(body);
  }
});

// Email invoice to customer or a specific address
// POST /invoices/:id/email            -> sends to customer email on file
// POST /invoices/:id/email?to=a@b.com -> sends to that email
// Body can also be { "to": "a@b.com" }
app.post('/invoices/:id/email', requireAuth, async (req, res) => {
  try {
    const to = req.query.to || req.body?.to || null;
    const accessToken = await ensureAccessToken();
    const q = to ? `&sendTo=${encodeURIComponent(to)}` : '';
    const url = `${apiBase()}/invoice/${encodeURIComponent(req.params.id)}/send?minorversion=73${q}`;
    const { data } = await axios.post(url, null, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/octet-stream'
      }
    });
    res.json(data);
  } catch (err) {
    const msg = err.response?.data || { error: err.message };
    res.status(err.response?.status || 400).json(msg);
  }
});

// Disconnect
app.post('/auth/disconnect', (req, res) => {
  store = { realmId: null };
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
  console.log('Visit /auth/connect to link QuickBooks.');
});
