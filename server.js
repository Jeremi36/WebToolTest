const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const { Pool } = require("pg");
const crypto = require("crypto");
const session = require("express-session");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", true);
app.use(session({
  secret: process.env.SESSION_SECRET || "change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: "lax"
  }
}));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function getIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
}

function randomLicense(tier) {
  const prefix = tier.toUpperCase();
  const part1 = crypto.randomBytes(3).toString("hex").toUpperCase();
  const part2 = crypto.randomBytes(3).toString("hex").toUpperCase();
  const part3 = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${part1}-${part2}-${part3}`;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tiers (
      tier TEXT PRIMARY KEY,
      max_devices INT NOT NULL,
      requests_per_minute INT NOT NULL,
      daily_request_limit INT NOT NULL,
      is_admin BOOLEAN DEFAULT false
    );
  `);

  await pool.query(`
    INSERT INTO tiers (tier, max_devices, requests_per_minute, daily_request_limit, is_admin)
    VALUES
      ('standard', 2, 10, 100, false),
      ('premium', 4, 25, 300, false),
      ('gold', 5, 50, 700, false),
      ('admin', 9999, 999999, 999999, true)
    ON CONFLICT (tier) DO NOTHING;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS licenses (
      id SERIAL PRIMARY KEY,
      license_key TEXT UNIQUE NOT NULL,
      tier TEXT NOT NULL DEFAULT 'standard',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS license_devices (
      id SERIAL PRIMARY KEY,
      license_key TEXT NOT NULL,
      hwid TEXT NOT NULL,
      ip_address TEXT,
      first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (license_key, hwid)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      conversation_code TEXT UNIQUE NOT NULL,
      license_key TEXT NOT NULL,
      history JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id SERIAL PRIMARY KEY,
      license_key TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_usage (
      id SERIAL PRIMARY KEY,
      license_key TEXT NOT NULL,
      usage_date DATE NOT NULL,
      request_count INT DEFAULT 0,
      UNIQUE (license_key, usage_date)
    );
  `);

  await pool.query(`
    INSERT INTO licenses (license_key, tier, active)
    VALUES ('ADMIN-OMEGA-001', 'admin', true)
    ON CONFLICT (license_key) DO NOTHING;
  `);
}

async function getLicenseInfo(licenseKey) {
  const result = await pool.query(`
    SELECT l.license_key, l.active, l.tier,
           t.max_devices, t.requests_per_minute, t.daily_request_limit, t.is_admin
    FROM licenses l
    JOIN tiers t ON l.tier = t.tier
    WHERE l.license_key=$1
  `, [licenseKey]);

  return result.rows[0] || null;
}

async function checkLimits(licenseInfo) {
  if (licenseInfo.is_admin) {
    return { ok: true };
  }

  const licenseKey = licenseInfo.license_key;

  const rateResult = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM request_logs
    WHERE license_key=$1
    AND created_at > NOW() - INTERVAL '1 minute'
  `, [licenseKey]);

  if (rateResult.rows[0].count >= licenseInfo.requests_per_minute) {
    return {
      ok: false,
      status: "RATE_LIMITED",
      message: `Rate limit reached. Try again in a minute.`
    };
  }

  const usageResult = await pool.query(`
    SELECT request_count
    FROM daily_usage
    WHERE license_key=$1
    AND usage_date=CURRENT_DATE
  `, [licenseKey]);

  const todayCount = usageResult.rows[0]?.request_count || 0;

  if (todayCount >= licenseInfo.daily_request_limit) {
    return {
      ok: false,
      status: "DAILY_LIMIT_REACHED",
      message: `Daily request limit reached.`
    };
  }

  return { ok: true };
}

async function recordUsage(licenseKey, isAdmin) {
  if (isAdmin) return;

  await pool.query(
    `INSERT INTO request_logs (license_key) VALUES ($1)`,
    [licenseKey]
  );

  await pool.query(`
    INSERT INTO daily_usage (license_key, usage_date, request_count)
    VALUES ($1, CURRENT_DATE, 1)
    ON CONFLICT (license_key, usage_date)
    DO UPDATE SET request_count = daily_usage.request_count + 1
  `, [licenseKey]);
}

function page(title, body) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <title>${title}</title>
    <style>
      body { font-family: Arial; background:#111; color:#eee; padding:30px; }
      input, button, select, textarea { padding:10px; margin:5px; border-radius:8px; border:0; }
      button { cursor:pointer; background:#ff8c00; color:#111; font-weight:bold; }
      table { border-collapse: collapse; width:100%; margin-top:20px; }
      td, th { border:1px solid #444; padding:10px; vertical-align:top; }
      a { color:#ff8c00; }
      .box { background:#1d1d1d; padding:20px; border-radius:16px; margin-bottom:20px; }
      code { background:#222; padding:3px 6px; border-radius:6px; }
    </style>
  </head>
  <body>
    <h1>${title}</h1>
    ${body}
  </body>
  </html>`;
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdminAuthenticated) {
    return next();
  }

  return res.send(page("Admin Login", `
    <form method="POST" action="/admin/login">
      <input name="password" type="password" placeholder="Admin password" required>
      <button>Login</button>
    </form>
  `));
}

app.get("/", (req, res) => {
  res.json({ status: "OK", message: "WebToolTest API online" });
});

app.post("/validate", async (req, res) => {
  const { license, hwid } = req.body;
  const ip = getIp(req);

  if (!license || !hwid) {
    return res.json({ status: "ERROR", message: "Missing fields" });
  }

  const licenseInfo = await getLicenseInfo(license);

  if (!licenseInfo || !licenseInfo.active) {
    return res.json({ status: "INVALID" });
  }

  if (licenseInfo.is_admin) {
    return res.json({ status: "VALID", admin: true, tier: licenseInfo.tier });
  }

  const existingDevice = await pool.query(`
    SELECT * FROM license_devices
    WHERE license_key=$1 AND hwid=$2
  `, [license, hwid]);

  if (existingDevice.rows.length > 0) {
    await pool.query(`
      UPDATE license_devices
      SET ip_address=$1, last_seen=CURRENT_TIMESTAMP
      WHERE license_key=$2 AND hwid=$3
    `, [ip, license, hwid]);

    return res.json({ status: "VALID", admin: false, tier: licenseInfo.tier });
  }

  const deviceCount = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM license_devices
    WHERE license_key=$1
  `, [license]);

  if (deviceCount.rows[0].count >= licenseInfo.max_devices) {
    return res.json({
      status: "DEVICE_LIMIT_REACHED",
      message: `Device limit reached for ${licenseInfo.tier}.`
    });
  }

  await pool.query(`
    INSERT INTO license_devices (license_key, hwid, ip_address)
    VALUES ($1, $2, $3)
  `, [license, hwid, ip]);

  return res.json({ status: "VALID", admin: false, tier: licenseInfo.tier });
});

app.post("/chat", async (req, res) => {
  try {
    const { license, messages, conversation_code } = req.body;

    if (!license || !Array.isArray(messages)) {
      return res.json({ status: "ERROR", message: "Missing license or messages" });
    }

    const licenseInfo = await getLicenseInfo(license);

    if (!licenseInfo || !licenseInfo.active) {
      return res.json({ status: "INVALID" });
    }

    const limitCheck = await checkLimits(licenseInfo);
    if (!limitCheck.ok) {
      return res.json(limitCheck);
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 500,
    });

    const reply = completion.choices?.[0]?.message?.content || "No response.";
    const conversationCode =
      conversation_code || "CONV-" + Math.random().toString(16).slice(2, 10).toUpperCase();

    const finalHistory = [
      ...messages,
      { role: "assistant", content: reply }
    ];

    await pool.query(`
      INSERT INTO conversations (conversation_code, license_key, history)
      VALUES ($1, $2, $3)
      ON CONFLICT (conversation_code)
      DO UPDATE SET history=$3, updated_at=CURRENT_TIMESTAMP
    `, [conversationCode, license, JSON.stringify(finalHistory)]);

    await recordUsage(license, licenseInfo.is_admin);

    res.json({
      status: "OK",
      conversation_code: conversationCode,
      reply,
      tier: licenseInfo.tier
    });
  } catch (err) {
    res.json({ status: "ERROR", message: err.message });
  }
});

app.get("/admin", requireAdmin, async (req, res) => {
  const pass = req.query.pass;

  const licenses = await pool.query(`
    SELECT l.*,
      t.max_devices,
      t.requests_per_minute,
      t.daily_request_limit,
      t.is_admin,
      COALESCE(d.device_count, 0) AS device_count,
      COALESCE(u.request_count, 0) AS today_requests
    FROM licenses l
    JOIN tiers t ON l.tier = t.tier
    LEFT JOIN (
      SELECT license_key, COUNT(*)::int AS device_count
      FROM license_devices
      GROUP BY license_key
    ) d ON l.license_key = d.license_key
    LEFT JOIN (
      SELECT license_key, request_count
      FROM daily_usage
      WHERE usage_date = CURRENT_DATE
    ) u ON l.license_key = u.license_key
    ORDER BY l.id DESC
  `);

  const tiers = await pool.query(`SELECT * FROM tiers ORDER BY is_admin, tier`);
  const conversations = await pool.query(`
    SELECT * FROM conversations
    ORDER BY updated_at DESC
    LIMIT 20
  `);

  res.send(page("Admin Panel", `
    <div class="box">
      <h2>Create Random License</h2>
      <form method="POST" action="/admin/random-license">
        <input type="hidden" name="pass" value="${pass}">
        <select name="tier">
          <option value="standard">Standard</option>
          <option value="premium">Premium</option>
          <option value="gold">Gold</option>
          <option value="admin">Admin</option>
        </select>
        <button>Create Random Key</button>
      </form>
    </div>

    <div class="box">
      <h2>Create Custom License</h2>
      <form method="POST" action="/admin/licenses">
        <input type="hidden" name="pass" value="${pass}">
        <input name="license_key" placeholder="License key" required>
        <select name="tier">
          <option value="standard">Standard</option>
          <option value="premium">Premium</option>
          <option value="gold">Gold</option>
          <option value="admin">Admin</option>
        </select>
        <button>Create</button>
      </form>
    </div>

    <div class="box">
      <h2>Tier Settings</h2>
      <table>
        <tr>
          <th>Tier</th><th>Devices</th><th>Requests/min</th><th>Daily limit</th><th>Admin</th><th>Save</th>
        </tr>
        ${tiers.rows.map(t => `
          <tr>
            <form method="POST" action="/admin/update-tier">
              <input type="hidden" name="pass" value="${pass}">
              <input type="hidden" name="tier" value="${t.tier}">
              <td>${t.tier}</td>
              <td><input name="max_devices" value="${t.max_devices}" size="5"></td>
              <td><input name="requests_per_minute" value="${t.requests_per_minute}" size="5"></td>
              <td><input name="daily_request_limit" value="${t.daily_request_limit}" size="5"></td>
              <td>${t.is_admin}</td>
              <td><button>Save</button></td>
            </form>
          </tr>
        `).join("")}
      </table>
    </div>

    <div class="box">
      <h2>Licenses</h2>
      <table>
        <tr>
          <th>Key</th>
          <th>Tier</th>
          <th>Active</th>
          <th>Devices</th>
          <th>Today</th>
          <th>Limits</th>
          <th>Actions</th>
        </tr>
        ${licenses.rows.map(l => `
          <tr>
            <td><code>${l.license_key}</code></td>
            <td>${l.tier}</td>
            <td>${l.active}</td>
            <td>${l.device_count}/${l.max_devices}</td>
            <td>${l.today_requests}/${l.daily_request_limit}</td>
            <td>${l.requests_per_minute}/min</td>
            <td>
              <form method="POST" action="/admin/toggle-license" style="display:inline;">
                <input type="hidden" name="pass" value="${pass}">
                <input type="hidden" name="license_key" value="${l.license_key}">
                <button>${l.active ? "Disable" : "Enable"}</button>
              </form>

              <form method="POST" action="/admin/reset-devices" style="display:inline;">
                <input type="hidden" name="pass" value="${pass}">
                <input type="hidden" name="license_key" value="${l.license_key}">
                <button>Reset Devices</button>
              </form>

              <form method="POST" action="/admin/delete-license" style="display:inline;">
                <input type="hidden" name="pass" value="${pass}">
                <input type="hidden" name="license_key" value="${l.license_key}">
                <button>Delete</button>
              </form>
            </td>
          </tr>
        `).join("")}
      </table>
    </div>

    <div class="box">
      <h2>Latest Conversations</h2>
      <table>
        <tr>
          <th>Code</th><th>License</th><th>Updated</th><th>View</th>
        </tr>
        ${conversations.rows.map(c => `
          <tr>
            <td>${c.conversation_code}</td>
            <td>${c.license_key}</td>
            <td>${c.updated_at}</td>
            <td><a href="/admin/conversation/${c.conversation_code}?pass=${pass}">Open</a></td>
          </tr>
        `).join("")}
      </table>
    </div>
  `));
});

app.post("/admin/random-license", requireAdmin, async (req, res) => {
  const { tier, pass } = req.body;
  const licenseKey = randomLicense(tier);

  await pool.query(`
    INSERT INTO licenses (license_key, tier, active)
    VALUES ($1, $2, true)
  `, [licenseKey, tier]);

  res.redirect(`/admin?pass=${pass}`);
});

app.post("/admin/licenses", requireAdmin, async (req, res) => {
  const { license_key, tier, pass } = req.body;

  await pool.query(`
    INSERT INTO licenses (license_key, tier, active)
    VALUES ($1, $2, true)
    ON CONFLICT (license_key) DO NOTHING
  `, [license_key, tier]);

  res.redirect(`/admin?pass=${pass}`);
});

app.post("/admin/update-tier", requireAdmin, async (req, res) => {
  const { tier, max_devices, requests_per_minute, daily_request_limit, pass } = req.body;

  await pool.query(`
    UPDATE tiers
    SET max_devices=$1,
        requests_per_minute=$2,
        daily_request_limit=$3
    WHERE tier=$4
  `, [
    parseInt(max_devices),
    parseInt(requests_per_minute),
    parseInt(daily_request_limit),
    tier
  ]);

  res.redirect(`/admin?pass=${pass}`);
});

app.post("/admin/toggle-license", requireAdmin, async (req, res) => {
  const { license_key, pass } = req.body;

  await pool.query(`
    UPDATE licenses
    SET active = NOT active
    WHERE license_key=$1
  `, [license_key]);

  res.redirect(`/admin?pass=${pass}`);
});

app.post("/admin/reset-devices", requireAdmin, async (req, res) => {
  const { license_key, pass } = req.body;

  await pool.query(`
    DELETE FROM license_devices
    WHERE license_key=$1
  `, [license_key]);

  res.redirect(`/admin?pass=${pass}`);
});

app.post("/admin/delete-license", requireAdmin, async (req, res) => {
  const { license_key, pass } = req.body;

  await pool.query("DELETE FROM license_devices WHERE license_key=$1", [license_key]);
  await pool.query("DELETE FROM daily_usage WHERE license_key=$1", [license_key]);
  await pool.query("DELETE FROM request_logs WHERE license_key=$1", [license_key]);
  await pool.query("DELETE FROM licenses WHERE license_key=$1", [license_key]);

  res.redirect(`/admin?pass=${pass}`);
});

app.get("/admin/conversation/:code", requireAdmin, async (req, res) => {
  const pass = req.query.pass;
  const code = req.params.code;

  const result = await pool.query(
    "SELECT * FROM conversations WHERE conversation_code=$1",
    [code]
  );

  if (result.rows.length === 0) {
    return res.send(page("Not Found", `<p>Conversation not found.</p>`));
  }

  const convo = result.rows[0];

  res.send(page(`Conversation ${code}`, `
    <p><a href="/admin?pass=${pass}">Back</a></p>
    <pre style="white-space:pre-wrap;background:#1d1d1d;padding:20px;border-radius:16px;">${JSON.stringify(convo.history, null, 2)}</pre>
  `));
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
