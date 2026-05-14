const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS licenses (
      id SERIAL PRIMARY KEY,
      license_key TEXT UNIQUE NOT NULL,
      hwid TEXT,
      ip_address TEXT,
      tier TEXT DEFAULT 'standard',
      max_devices INT DEFAULT 1,
      active BOOLEAN DEFAULT true,
      is_admin BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    INSERT INTO licenses (license_key, tier, max_devices, active, is_admin)
    VALUES ('ADMIN-OMEGA-001', 'admin', 9999, true, true)
    ON CONFLICT (license_key) DO NOTHING;
  `);
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
      td, th { border:1px solid #444; padding:10px; }
      a { color:#ff8c00; }
      .box { background:#1d1d1d; padding:20px; border-radius:16px; margin-bottom:20px; }
    </style>
  </head>
  <body>
    <h1>${title}</h1>
    ${body}
  </body>
  </html>`;
}

function requireAdmin(req, res, next) {
  const pass = req.query.pass || req.body.pass;
  if (pass !== ADMIN_PASSWORD) {
    return res.send(page("Admin Login", `
      <form method="GET" action="/admin">
        <input name="pass" type="password" placeholder="Admin password">
        <button>Login</button>
      </form>
    `));
  }
  next();
}

app.get("/", (req, res) => {
  res.json({ status: "OK", message: "WebToolTest API online" });
});

app.post("/validate", async (req, res) => {
  const { license, hwid } = req.body;
  const ip =
  req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
  req.socket.remoteAddress ||
  "";

  if (!license || !hwid) {
    return res.json({ status: "ERROR", message: "Missing fields" });
  }

  const result = await pool.query(
    "SELECT * FROM licenses WHERE license_key=$1 AND active=true",
    [license]
  );

  if (result.rows.length === 0) {
    return res.json({ status: "INVALID" });
  }

  const entry = result.rows[0];

  if (entry.is_admin) {
    return res.json({ status: "VALID", admin: true });
  }

  if (!entry.hwid) {
    await pool.query(
      "UPDATE licenses SET hwid=$1, ip_address=$2 WHERE license_key=$3",
      [hwid, ip, license]
    );

    return res.json({ status: "VALID", admin: false });
  }

  if (entry.hwid === hwid) {
    return res.json({ status: "VALID", admin: false });
  }

  return res.json({ status: "USED" });
});

app.post("/chat", async (req, res) => {
  try {
    const { license, messages, conversation_code } = req.body;

    if (!license || !Array.isArray(messages)) {
      return res.json({ status: "ERROR", message: "Missing license or messages" });
    }

    const licenseResult = await pool.query(
      "SELECT * FROM licenses WHERE license_key=$1 AND active=true",
      [license]
    );

    if (licenseResult.rows.length === 0) {
      return res.json({ status: "INVALID" });
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

    res.json({
      status: "OK",
      conversation_code: conversationCode,
      reply,
    });
  } catch (err) {
    res.json({ status: "ERROR", message: err.message });
  }
});

app.get("/admin", requireAdmin, async (req, res) => {
  const pass = req.query.pass;

  const licenses = await pool.query("SELECT * FROM licenses ORDER BY id DESC");
  const conversations = await pool.query("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 20");

  res.send(page("Admin Panel", `
    <div class="box">
      <h2>Create License</h2>
      <form method="POST" action="/admin/licenses">
        <input type="hidden" name="pass" value="${pass}">
        <input name="license_key" placeholder="License key" required>
        <select name="is_admin">
          <option value="false">Normal</option>
          <option value="true">Admin</option>
        </select>
        <button>Create</button>
      </form>
    </div>

    <div class="box">
      <h2>Licenses</h2>
      <table>
        <tr>
          <th>Key</th><th>Tier</th><th>HWID</th><th>Active</th><th>Admin</th><th>Action</th>
        </tr>
        ${licenses.rows.map(l => `
          <tr>
            <td>${l.license_key}</td>
            <td>${l.tier}</td>
            <td>${l.hwid || "-"}</td>
            <td>${l.active}</td>
            <td>${l.is_admin}</td>
            <td>
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

app.post("/admin/licenses", requireAdmin, async (req, res) => {
  const { license_key, is_admin, pass } = req.body;

  await pool.query(`
    INSERT INTO licenses (license_key, tier, max_devices, active, is_admin)
    VALUES ($1, $2, $3, true, $4)
    ON CONFLICT (license_key) DO NOTHING
  `, [
    license_key,
    is_admin === "true" ? "admin" : "standard",
    is_admin === "true" ? 9999 : 1,
    is_admin === "true"
  ]);

  res.redirect(`/admin?pass=${pass}`);
});

app.post("/admin/delete-license", requireAdmin, async (req, res) => {
  const { license_key, pass } = req.body;
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
