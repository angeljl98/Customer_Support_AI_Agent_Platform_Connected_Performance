const express = require('express');
const app = express();
app.use(express.json());

// healthcheck
app.get('/health', (_req, res) => res.send('ok'));

// tu endpoint (ejemplo)
app.post('/cmocreate', (req, res) => {
  console.log('payload:', req.body);
  res.json({ ok: true, received: req.body });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Up on', port));
