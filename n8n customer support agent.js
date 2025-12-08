// Customer Support AI Agent
// Integrates HelpScout, Gmail, Google Docs, OpenAI GPT, and Slack

const express = require('express');
const { google } = require('googleapis');
const OpenAI = require('openai');
const { WebClient } = require('@slack/web-api');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { URLSearchParams } = require('url'); // para construir URLs
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

  // === Option B: allow GOOGLE_SERVICE_ACCOUNT_KEY to contain JSON ===
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
        keyFile, // now either a path or /tmp file if JSON was provided
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

  async processTicket(ticket, opts = {}) {
    const { skipEmail = false, skipAI = false, draftText = null } = opts;

    try {
      console.log(`Processing ticket ${ticket?.id} from ${ticket?.source}`, {
        skipEmail,
        skipAI,
        hasDraft: !!draftText,
      });

      // 1) Store ticket in Google Doc
      await this.storeTicketInDoc(ticket);

      // 2) Knowledge base context placeholder
      const context = await this.getKnowledgeBaseContext(ticket);

      // 3) Generate response (use draft if provided; if skipAI and no draft, use fallback)
      let aiResponse = draftText;
      if (!aiResponse) {
        if (!skipAI) {
          aiResponse = await this.generateAIResponse(ticket, context);
        } else {
          aiResponse =
            'Thanks for reaching out! Our team has received your request and will follow up shortly with details.';
        }
      }

      // 4) Send email only if not skipped
      if (!skipEmail) {
        await this.sendGmailResponse(ticket, aiResponse);
      }

      // 5) Always notify Slack (with preview + full response in thread)
      const slackInfo = await this.notifySlackChannel(ticket, aiResponse);

      // 6) Update KB/logging placeholder
      await this.updateKnowledgeBase(ticket, aiResponse);

      return {
        ok: true,
        ticketId: ticket?.id || null,
        used_ai: !skipAI && !draftText,
        emailed: !skipEmail,
        summary: {
          source: ticket?.source || null,
          subject: ticket?.subject || null,
          customer: {
            name: ticket?.customer?.name || null,
            email: ticket?.customer?.email || null,
          },
          message_preview: (((ticket?.messages?.[0]?.body || ticket?.messages?.[0]?.text || '') + '').slice(0, 180)),
          response_preview: (aiResponse || '').slice(0, 180),
          flags: { skip_email: skipEmail, skip_ai: skipAI, has_draft: !!draftText }
        },
        slack: slackInfo || null
      };
    } catch (error) {
      console.error('Error processing ticket:', error);
      try { await this.notifySlackChannel(ticket, null, error); } catch {}
      throw error;
    }
  }

  async storeTicketInDoc(ticket) {
    const docId = process.env.GOOGLE_DOC_ID;
    if (!docId) {
      console.warn('GOOGLE_DOC_ID is not set; skipping doc write');
      return;
    }

    const timestamp = new Date().toISOString();
    const content = `\n---\nTicket ID: ${ticket.id}\nDate: ${timestamp}\nSource: ${ticket.source}\nCustomer: ${ticket.customer?.name} (${ticket.customer?.email})\nSubject: ${ticket.subject}\n\nMessages:\n${(ticket.messages || [])
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

  async generateAIResponse(ticket, context) {
    const prompt = `\nYou are a helpful customer support agent for our software platform. \n\nCustomer Information:\n- Name: ${ticket.customer?.name}\n- Email: ${ticket.customer?.email}\n- Subject: ${ticket.subject}\n\nCustomer Message:\n${(ticket.messages || [])
      .map((msg) => msg.body || msg.text || 'No content')
      .join('\n')}\n\nKnowledge Base Context:\n${JSON.stringify(context, null, 2)}\n\nPlease generate a helpful, professional response that:\n1. Addresses the customer's specific question or concern\n2. Provides step-by-step guidance when appropriate\n3. References relevant platform features or documentation\n4. Maintains a friendly, professional tone\n5. Offers additional help if needed\n\nResponse:`;

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a helpful customer support agent specializing in software platform assistance.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 500,
        temperature: 0.7,
      });

      const response = completion.choices?.[0]?.message?.content || '';
      console.log('AI response generated');
      return (
        response ||
        "Thank you for contacting our support team. We've received your inquiry and will respond shortly with a personalized solution."
      );
    } catch (error) {
      console.error('Error generating AI response:', error);
      return "Thank you for contacting our support team. We've received your inquiry and will respond shortly with a personalized solution.";
    }
  }

  async sendGmailResponse(ticket, response) {
    try {
      const emailContent = `To: ${ticket.customer?.email}\nSubject: Re: ${ticket.subject}\nContent-Type: text/plain; charset=utf-8\n\nHi ${ticket.customer?.name || ''},\n\n${response}\n\nBest regards,\nCustomer Support Team\n\n---\nThis is an automated response. If you need further assistance, please reply to this email.`;

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

  // 🔹 Slack notification (Reply + Full Conversation)
  async notifySlackChannel(ticket, response, error = null) {
    const channelId = process.env.SLACK_SUPPORT_CHANNEL_ID;
    const replyFormBase = process.env.N8N_REPLY_FORM_URL;       // form de reply
    const conversationBase = process.env.N8N_CONVERSATION_URL;  // webhook para ver conversación

    // Mensaje original del cliente
    const customerMessageRaw =
      (ticket?.messages?.[0]?.body || ticket?.messages?.[0]?.text || '') || '';
    const customerMessageShort = customerMessageRaw.slice(0, 500);

    // URL del formulario de reply
    let replyUrl = null;
    if (replyFormBase) {
      const params = new URLSearchParams({
        ticketId: (ticket?.id || '').toString(),
        name: ticket?.customer?.name || '',
        email: ticket?.customer?.email || '',
        subject: ticket?.subject || '',
        source: ticket?.source || '',
        customerMessage: customerMessageRaw.slice(0, 1000),
      });
      replyUrl = `${replyFormBase}?${params.toString()}`;
    }

    // URL para ver la conversación completa (Google Sheets vía n8n)
    let conversationUrl = null;
    if (conversationBase && ticket?.id) {
      const sep = conversationBase.includes('?') ? '&' : '?';
      conversationUrl = `${conversationBase}${sep}ticketId=${encodeURIComponent(
        ticket.id
      )}`;
    }

    try {
      let message;

      if (error) {
        // --- Mensaje de error ---
        message = {
          text: `🚨 Error processing ticket ${ticket?.id}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Error Processing Ticket*\n*ID:* ${ticket?.id}\n*Customer:* ${ticket?.customer?.name} (${ticket?.customer?.email})\n*Subject:* ${ticket?.subject}\n*Error:* ${error?.message || error}`,
              },
            },
          ],
        };
      } else {
        // --- Mensaje normal de ticket ---
        const preview = (response || '').slice(0, 200) +
          ((response || '').length > 200 ? '...' : '');

        const blocks = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                `*New Support Ticket*\n` +
                `*Ticket ID:* ${ticket?.id}\n` +
                `*Customer:* ${ticket?.customer?.name} (${ticket?.customer?.email})\n` +
                `*Subject:* ${ticket?.subject}\n` +
                `*Source:* ${ticket?.source}`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Customer Message:*\n${customerMessageShort || '_No message body_'}`,
            },
          },
        ];

        if (response) {
          blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: `*Response Preview:*\n${preview}` },
          });
        }

        // Botones
        const actionElements = [];

        if (replyUrl) {
          actionElements.push({
            type: 'button',
            text: { type: 'plain_text', text: 'Reply', emoji: true },
            url: replyUrl,
          });
        }

        if (conversationUrl) {
          actionElements.push({
            type: 'button',
            text: { type: 'plain_text', text: 'Full Conversation' },
            url: conversationUrl,
          });
        }

        if (actionElements.length > 0) {
          blocks.push({
            type: 'actions',
            elements: actionElements,
          });
        }

        message = {
          text: `New support ticket${ticket?.id ? ` ${ticket.id}` : ''}`,
          blocks,
        };
      }

      // Post parent message
      const post = await this.slack.chat.postMessage({ channel: channelId, ...message });
      const threadTs = post.ts || post.message?.ts;

      // If we have a full response, post it in the thread as well
      if (!error && response) {
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

  async updateKnowledgeBase(ticket, response) {
    const interaction = {
      timestamp: new Date().toISOString(),
      ticketId: ticket?.id,
      customerQuery: (ticket?.messages || []).map((m) => m.body || m.text).join(' '),
      aiResponse: response,
      customerEmail: ticket?.customer?.email,
      subject: ticket?.subject,
      source: ticket?.source,
    };
    console.log('Knowledge base updated with interaction:', interaction.ticketId);
  }

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
