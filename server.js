// server.js
// Levanta la clase que ya define /process-ticket, /webhook/helpscout y /webhook/gmail
const CustomerSupportAgent = require('./n8n customer support agent.js');

// Instancia única y reutilizamos SU app de Express
const agent = new CustomerSupportAgent();
const app = agent.app;

// ====== Healthcheck (para Render) ======
app.get('/health', (_req, res) => res.send('ok'));

// ====== Utilidad de prueba: enviar mensaje a Slack ======
async function postToSlack({ text, channel = process.env.SLACK_SUPPORT_CHANNEL_ID }) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !channel) throw new Error('Missing SLACK_BOT_TOKEN or SLACK_SUPPORT_CHANNEL_ID');

  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({ channel, text })
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`Slack error: ${JSON.stringify(data)}`);
  return data;
}

// ====== Rutas de prueba (opcionales, las conservamos) ======
app.post('/test/slack', async (req, res) => {
  try {
    const text = req.body?.text || `Server alive ✅ ${new Date().toISOString()}`;
    const r = await postToSlack({ text });
    res.json({ ok: true, channel: r.channel, ts: r.ts || r.message?.ts });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/cmocreate', async (req, res) => {
  try {
    const { taskType = 'post', content = '(sin contenido)' } = req.body || {};
    await postToSlack({ text: `New *${taskType}* received:\n${content}` });
    res.json({ ok: true, received: req.body });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====== Start ======
const PORT = process.env.PORT || 3000;
agent.start(PORT);
console.log('Server listening on', PORT);

