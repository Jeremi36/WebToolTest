const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Temporary in-memory database
const licenses = {
  "ADMIN-OMEGA-001": {
    active: true,
    isAdmin: true,
    hwid: null,
  },
};

const conversations = {};

app.get("/", (req, res) => {
  res.json({
    status: "OK",
    message: "WebToolTest API online",
  });
});

app.post("/validate", (req, res) => {
  const { license, hwid } = req.body;

  if (!license || !hwid) {
    return res.json({
      status: "ERROR",
      message: "Missing fields",
    });
  }

  const entry = licenses[license];

  if (!entry || !entry.active) {
    return res.json({
      status: "INVALID",
    });
  }

  if (entry.isAdmin) {
    return res.json({
      status: "VALID",
      admin: true,
    });
  }

  if (!entry.hwid) {
    entry.hwid = hwid;
    return res.json({
      status: "VALID",
      admin: false,
    });
  }

  if (entry.hwid === hwid) {
    return res.json({
      status: "VALID",
      admin: false,
    });
  }

  return res.json({
    status: "USED",
  });
});

app.post("/chat", async (req, res) => {
  try {
    const { license, messages, conversation_code } = req.body;

    if (!license || !messages || !Array.isArray(messages)) {
      return res.json({
        status: "ERROR",
        message: "Missing license or messages",
      });
    }

    const entry = licenses[license];

    if (!entry || !entry.active) {
      return res.json({
        status: "INVALID",
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      max_tokens: 500,
    });

    const reply =
      completion.choices?.[0]?.message?.content || "No response.";

    const conversationCode =
      conversation_code || "CONV-" + Math.random().toString(16).slice(2, 10).toUpperCase();

    if (!entry.isAdmin) {
      conversations[conversationCode] = [...messages, {
        role: "assistant",
        content: reply,
      }];
    }

    res.json({
      status: "OK",
      conversation_code: conversationCode,
      reply,
    });
  } catch (err) {
    res.json({
      status: "ERROR",
      message: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});