const express = require('express');
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

// Utilidad para enviar mensajes a Slack
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

// Health
app.get('/health', (_req, res) => res.send('ok'));

// Test rápido: envía un mensaje al canal de soporte
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

// Tu endpoint base para luego conectar la lógica real
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

app.listen(PORT, () => console.log('Server listening on', PORT));
