// Customer Support AI Agent
// Integrates HelpScout, Gmail, Google Docs, OpenAI GPT, and Slack

const express = require('express');
const { google } = require('googleapis');
const OpenAI = require('openai');
const { WebClient } = require('@slack/web-api');
const axios = require('axios');
const nodemailer = require('nodemailer');
require('dotenv').config();

class CustomerSupportAgent {
  constructor() {
    this.app = express();
    this.app.use(express.json());

    // Initialize API clients
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.slack = new WebClient(process.env.SLACK_BOT_TOKEN);

    this.gmail = null;
    this.docs = null;
    this.initializeGoogleServices();

    this.setupRoutes();
  }

  // === Allow GOOGLE_SERVICE_ACCOUNT_KEY to contain JSON or path ===
  async initializeGoogleServices() {
    try {
      let keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY; // may be a PATH or raw JSON
      if (keyFile && keyFile.trim().startsWith('{')) {
        const fs = require('fs');
        const p = '/tmp/google-sa.json';
        fs.writeFileSync(p, keyFile);
        keyFile = p;
      }

      const auth = new google.auth.GoogleAuth({
        keyFile,
        scopes: [
          'https://www.googleapis.com/auth/gmail.modify',
          'https://www.googleapis.com/auth/documents',
        ],
      });

      this.gmail = google.gmail({ version: 'v1', auth });
      this.docs = google.docs({ version: 'v1', auth });
    } catch (err) {
      console.error('Google services init error:', err);
    }
  }

  setupRoutes() {
    // Health (for Render/monitoring)
    this.app.get('/health', (_req, res) => res.send('ok'));

    // HelpScout webhook endpoint
    this.app.post('/webhook/helpscout', async (req, res) => {
      try {
        await this.handleHelpScoutTicket(req.body);
        res.status(200).send('OK');
      } catch (error) {
        console.error('HelpScout webhook error:', error);
        res.status(500).send('Error processing ticket');
      }
    });

    // Gmail webhook endpoint (requires Gmail Push notifications setup)
    this.app.post('/webhook/gmail', async (req, res) => {
      try {
        await this.handleGmailMessage(req.body);
        res.status(200).send('OK');
      } catch (error) {
        console.error('Gmail webhook error:', error);
        res.status(500).send('Error processing email');
      }
    });

    // Manual processing endpoint (supports flags and draft)
    this.app.post('/process-ticket', async (req, res) => {
      try {
        const body = req.body || {};
        const skipEmail = body.skip_email === true || req.headers['x-skip-email'] === '1';
        const skipAI = body.skip_ai === true || req.headers['x-skip-ai'] === '1';
        const draftText = body.draft?.text || null;

        const response = await this.processTicket(body, { skipEmail, skipAI, draftText });
        res.status(200).json(response);
      } catch (error) {
        console.error('Manual processing error:', error);
        res.status(500).json({ ok: false, error: String(error?.message || error) });
      }
    });
  }

  // ---------- Helper: normalize customer data (name + email) ----------

  normalizeCustomer(ticket) {
    const t = ticket || {};
    let c = t.customer || t.Customer || {};

    // If customer comes as JSON string, try to parse it
    if (typeof c === 'string') {
      try {
        c = JSON.parse(c);
      } catch (e) {
        c = {};
      }
    }

    const name =
      c.name ||
      c.Name ||
      t.customer_name ||
      t.CustomerName ||
      t.Name ||
      t.name ||
      '';

    const email =
      c.email ||
      c.Email ||
      t.customer_email ||
      t.CustomerEmail ||
      t.Email ||
      t.email ||
      '';

    return { name: name || '', email: email || '' };
  }

  // ---------- Webhook handlers ----------

  async handleHelpScoutTicket(webhookData) {
    console.log('Processing HelpScout ticket:', webhookData?.id);

    const ticket = {
      id: webhookData.id,
      subject: webhookData.subject,
      customer: {
        email: webhookData.customer?.email,
        name: webhookData.customer?.name,
      },
      messages: webhookData.threads || [],
      source: 'helpscout',
    };

    return await this.processTicket(ticket);
  }

  async handleGmailMessage(pushData) {
    console.log('Processing Gmail message (push)');

    const message = JSON.parse(Buffer.from(pushData.message.data, 'base64').toString());

    const emailData = await this.gmail.users.messages.get({
      userId: 'me',
      id: message.emailAddress, // NOTE: adjust to actual messageId for real Gmail push config
    });

    const headers = emailData.data.payload.headers || [];
    const subject = headers.find((h) => h.name === 'Subject')?.value || '';
    const from = headers.find((h) => h.name === 'From')?.value || '';

    const ticket = {
      id: emailData.data.id,
      subject,
      customer: {
        email: from.match(/<(.+)>/)?.[1] || from,
        name: from.split('<')[0].trim(),
      },
      messages: [{ body: this.extractEmailBody(emailData.data.payload) }],
      source: 'gmail',
    };

    return await this.processTicket(ticket);
  }

  // ---------- Core pipeline ----------

  async processTicket(ticket, opts = {}) {
    const { skipEmail = false, skipAI = false, draftText = null } = opts;

    try {
      console.log(`Processing ticket ${ticket?.id} from ${ticket?.source}`, {
        skipEmail,
        skipAI,
        hasDraft: !!draftText,
      });

      const customer = this.normalizeCustomer(ticket);

      // 1) Store ticket in Google Doc
      await this.storeTicketInDoc(ticket, customer);

      // 2) Knowledge base context placeholder
      const context = await this.getKnowledgeBaseContext(ticket);

      // 3) Generate response (use draft if provided; if skipAI and no draft, response = '')
      let aiResponse = draftText;
      if (!aiResponse) {
        if (!skipAI) {
          aiResponse = await this.generateAIResponse(ticket, customer, context);
        } else {
          aiResponse = '';
        }
      }

      // 4) Send email only if not skipped AND we actually have a response
      if (!skipEmail) {
        await this.sendGmailResponse(ticket, customer, aiResponse);
      }

      // 5) Always notify Slack (ticket info + optional full response in thread)
      const slackInfo = await this.notifySlackChannel(ticket, customer, aiResponse);

      // 6) Update KB/logging placeholder
      await this.updateKnowledgeBase(ticket, aiResponse);

      return {
        ok: true,
        ticketId: ticket?.id || null,
        used_ai: !skipAI && !draftText,
        emailed: !skipEmail && !!(aiResponse && aiResponse.trim()),
        summary: {
          source: ticket?.source || null,
          subject: ticket?.subject || null,
          customer,
          message_preview: (
            ((ticket?.messages?.[0]?.body || ticket?.messages?.[0]?.text || '') + '').slice(0, 180)
          ),
          response_preview: (aiResponse || '').slice(0, 180),
          flags: { skip_email: skipEmail, skip_ai: skipAI, has_draft: !!draftText },
        },
        slack: slackInfo || null,
      };
    } catch (error) {
      console.error('Error processing ticket:', error);
      try {
        await this.notifySlackChannel(ticket, this.normalizeCustomer(ticket), null, error);
      } catch {}
      throw error;
    }
  }

  // ---------- Google Docs ----------

  async storeTicketInDoc(ticket, customer) {
    const docId = process.env.GOOGLE_DOC_ID;
    if (!docId) {
      console.warn('GOOGLE_DOC_ID is not set; skipping doc write');
      return;
    }

    const timestamp = new Date().toISOString();
    const content = `\n---\nTicket ID: ${ticket.id}\nDate: ${timestamp}\nSource: ${
      ticket.source
    }\nCustomer: ${customer.name} (${customer.email})\nSubject: ${ticket.subject}\n\nMessages:\n${(
      ticket.messages || []
    )
      .map((msg) => `- ${msg.body || msg.text || 'No content'}`)
      .join('\n')}\n---\n\n`;

    try {
      await this.docs.documents.batchUpdate({
        documentId: docId,
        requestBody: {
          requests: [
            {
              insertText: { location: { index: 1 }, text: content },
            },
          ],
        },
      });
      console.log('Ticket stored in Google Doc');
    } catch (error) {
      console.error('Error storing ticket in Google Doc:', error);
    }
  }

  async getKnowledgeBaseContext(_ticket) {
    // Placeholder: plug your real KB/RAG here
    return {
      commonIssues: [
        'Account setup and onboarding',
        'Feature usage and best practices',
        'Integration troubleshooting',
        'Billing and subscription questions',
      ],
      platformFeatures: [
        'User management',
        'API documentation',
        'Dashboard customization',
        'Data export/import',
      ],
    };
  }

  // ---------- OpenAI ----------

  async generateAIResponse(ticket, customer, context) {
    const prompt = `You are a helpful customer support agent for our software platform.

Customer Information:
- Name: ${customer.name}
- Email: ${customer.email}
- Subject: ${ticket.subject}

Customer Message:
${(ticket.messages || [])
  .map((msg) => msg.body || msg.text || 'No content')
  .join('\n')}

Knowledge Base Context:
${JSON.stringify(context, null, 2)}

Please generate a helpful, professional response that:
1. Addresses the customer's specific question or concern
2. Provides step-by-step guidance when appropriate
3. References relevant platform features or documentation
4. Maintains a friendly, professional tone
5. Offers additional help if needed

Response:`;

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful customer support agent specializing in software platform assistance.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 500,
        temperature: 0.7,
      });

      const response = (completion.choices?.[0]?.message?.content || '').trim();
      console.log('AI response generated');
      // No fallback genérico
      return response;
    } catch (error) {
      console.error('Error generating AI response:', error);
      // Si falla el modelo, devolvemos vacío para NO mandar mensaje automático
      return '';
    }
  }

  // ---------- Gmail ----------

  async sendGmailResponse(ticket, customer, response) {
    try {
      // Si no hay respuesta, no mandamos email
      if (!response || !response.trim()) {
        console.warn('No AI response available, skipping Gmail send.');
        return;
      }

      const emailContent = `To: ${customer.email}
Subject: Re: ${ticket.subject}
Content-Type: text/plain; charset=utf-8

Hi ${customer.name || ''},

${response}

Best regards,
Customer Support Team

---
This is an automated response. If you need further assistance, please reply to this email.`;

      const encodedEmail = Buffer.from(emailContent)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

      await this.gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodedEmail } });
      console.log('Response sent via Gmail');
    } catch (error) {
      console.error('Error sending Gmail response:', error);
    }
  }

  // ---------- Slack ----------

  async notifySlackChannel(ticket, customer, response, error = null) {
    const channelId = process.env.SLACK_SUPPORT_CHANNEL_ID;

    // Construimos líneas Customer + Email
    let customerLine;
    if (customer.name) {
      customerLine = `*Customer:* ${customer.name}`;
    } else if (customer.email) {
      customerLine = `*Customer:* ${customer.email}`;
    } else {
      customerLine = '*Customer:* Unknown customer';
    }

    const emailLine = customer.email ? `\n*Email:* ${customer.email}` : '';

    try {
      let message;
      if (error) {
        message = {
          text: `🚨 Error processing ticket ${ticket?.id}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text:
                  `*Error Processing Ticket*\n` +
                  `*Ticket ID:* ${ticket?.id}\n` +
                  `${customerLine}${emailLine}\n` +
                  `*Subject:* ${ticket?.subject}\n` +
                  `*Error:* ${error?.message || error}`,
              },
            },
          ],
        };
      } else {
        const customerMessage = (
          (ticket?.messages?.[0]?.body || ticket?.messages?.[0]?.text || '') + ''
        ).slice(0, 500);

        message = {
          text: `New support ticket${ticket?.id ? ` ${ticket.id}` : ''}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text:
                  `*New Support Ticket*\n` +
                  `*Ticket ID:* ${ticket?.id}\n` +
                  `${customerLine}${emailLine}\n` +
                  `*Subject:* ${ticket?.subject}\n` +
                  `*Source:* ${ticket?.source}`,
              },
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Customer Message:*\n${customerMessage || '_No message body_'}`,
              },
            },
            // Sin botón ni "Response Preview"
          ],
        };
      }

      // Post parent message
      const post = await this.slack.chat.postMessage({ channel: channelId, ...message });
      const threadTs = post.ts || post.message?.ts;

      // Si tenemos una respuesta de IA NO vacía, la publicamos en el hilo
      if (!error && response && response.trim()) {
        const full = `*Full AI Response:*\n\n\`\`\`\n${response}\n\`\`\``;
        await this.slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: full });
      }

      console.log('Slack notification sent');
      return { channel: channelId, ts: threadTs };
    } catch (err) {
      console.error('Error sending Slack notification:', err);
      return null;
    }
  }

  // ---------- KB logging ----------

  async updateKnowledgeBase(ticket, response) {
    const customer = this.normalizeCustomer(ticket);

    const interaction = {
      timestamp: new Date().toISOString(),
      ticketId: ticket?.id,
      customerQuery: (ticket?.messages || []).map((m) => m.body || m.text).join(' '),
      aiResponse: response,
      customerEmail: customer.email,
      subject: ticket?.subject,
      source: ticket?.source,
    };
    console.log('Knowledge base updated with interaction:', interaction.ticketId);
  }

  // ---------- Utils ----------

  extractEmailBody(payload) {
    if (payload?.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString();
        }
      }
    } else if (payload?.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString();
    }
    return 'No content available';
  }

  start(port = 3000) {
    this.app.listen(port, () => {
      console.log(`Customer Support AI Agent running on port ${port}`);
      console.log('Endpoints:');
      console.log('- Health: GET /health');
      console.log('- HelpScout: POST /webhook/helpscout');
      console.log('- Gmail: POST /webhook/gmail');
      console.log('- Manual: POST /process-ticket');
    });
  }
}

if (require.main === module) {
  const agent = new CustomerSupportAgent();
  const PORT = process.env.PORT || 3000;
  agent.start(PORT);
}

module.exports = CustomerSupportAgent;

// Example .env file structure:
/*
OPENAI_API_KEY=your_openai_api_key
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
SLACK_SUPPORT_CHANNEL_ID=C1234567890
GOOGLE_SERVICE_ACCOUNT_KEY=path/to/service-account-key.json
GOOGLE_DOC_ID=your_google_doc_id
BASE_URL=https://your-domain.com
GMAIL_USER=support@yourcompany.com
*/

// Package.json dependencies needed:
/*
{
  "dependencies": {
    "express": "^4.18.2",
    "googleapis": "^118.0.0",
    "openai": "^4.20.1",
    "@slack/web-api": "^6.9.0",
    "axios": "^1.6.0",
    "nodemailer": "^6.9.7",
    "dotenv": "^16.3.1"
  }
}
*/
