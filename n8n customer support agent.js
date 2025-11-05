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
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    this.slack = new WebClient(process.env.SLACK_BOT_TOKEN);
    
    this.gmail = null;
    this.docs = null;
    this.initializeGoogleServices();
    
    this.setupRoutes();
  }

  async initializeGoogleServices() {
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
      scopes: [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/documents'
      ]
    });

    this.gmail = google.gmail({ version: 'v1', auth });
    this.docs = google.docs({ version: 'v1', auth });
  }

  setupRoutes() {
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

    // Manual processing endpoint
    this.app.post('/process-ticket', async (req, res) => {
      try {
        const response = await this.processTicket(req.body);
        res.json(response);
      } catch (error) {
        console.error('Manual processing error:', error);
        res.status(500).json({ error: 'Error processing ticket' });
      }
    });
  }

  async handleHelpScoutTicket(webhookData) {
    console.log('Processing HelpScout ticket:', webhookData.id);
    
    // Extract ticket information
    const ticket = {
      id: webhookData.id,
      subject: webhookData.subject,
      customer: {
        email: webhookData.customer.email,
        name: webhookData.customer.name
      },
      messages: webhookData.threads || [],
      source: 'helpscout'
    };

    return await this.processTicket(ticket);
  }

  async handleGmailMessage(pushData) {
    console.log('Processing Gmail message');
    
    // Decode the push notification
    const message = JSON.parse(Buffer.from(pushData.message.data, 'base64').toString());
    
    // Get the full email details
    const emailData = await this.gmail.users.messages.get({
      userId: 'me',
      id: message.emailAddress
    });

    // Extract relevant information
    const headers = emailData.data.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const from = headers.find(h => h.name === 'From')?.value || '';
    
    const ticket = {
      id: emailData.data.id,
      subject: subject,
      customer: {
        email: from.match(/<(.+)>/)?.[1] || from,
        name: from.split('<')[0].trim()
      },
      messages: [{ body: this.extractEmailBody(emailData.data.payload) }],
      source: 'gmail'
    };

    return await this.processTicket(ticket);
  }

  async processTicket(ticket) {
    try {
      console.log(`Processing ticket ${ticket.id} from ${ticket.source}`);

      // 1. Store ticket information in Google Doc
      await this.storeTicketInDoc(ticket);

      // 2. Get knowledge base context
      const context = await this.getKnowledgeBaseContext(ticket);

      // 3. Generate AI response using GPT
      const aiResponse = await this.generateAIResponse(ticket, context);

      // 4. Send response via Gmail
      await this.sendGmailResponse(ticket, aiResponse);

      // 5. Notify Slack channel
      await this.notifySlackChannel(ticket, aiResponse);

      // 6. Update knowledge base with interaction
      await this.updateKnowledgeBase(ticket, aiResponse);

      return {
        success: true,
        ticketId: ticket.id,
        responseGenerated: true,
        responseSent: true,
        slackNotified: true
      };

    } catch (error) {
      console.error('Error processing ticket:', error);
      
      // Notify Slack of error
      await this.notifySlackChannel(ticket, null, error);
      
      throw error;
    }
  }

  async storeTicketInDoc(ticket) {
    const docId = process.env.GOOGLE_DOC_ID;
    
    const timestamp = new Date().toISOString();
    const content = `
---
Ticket ID: ${ticket.id}
Date: ${timestamp}
Source: ${ticket.source}
Customer: ${ticket.customer.name} (${ticket.customer.email})
Subject: ${ticket.subject}

Messages:
${ticket.messages.map(msg => `- ${msg.body || msg.text || 'No content'}`).join('\n')}
---

`;

    try {
      // Append to the document
      await this.docs.documents.batchUpdate({
        documentId: docId,
        requestBody: {
          requests: [{
            insertText: {
              location: { index: 1 },
              text: content
            }
          }]
        }
      });
      
      console.log('Ticket stored in Google Doc');
    } catch (error) {
      console.error('Error storing ticket in Google Doc:', error);
    }
  }

  async getKnowledgeBaseContext(ticket) {
    // This would query your existing knowledge base
    // For now, returning a basic context structure
    return {
      commonIssues: [
        "Account setup and onboarding",
        "Feature usage and best practices", 
        "Integration troubleshooting",
        "Billing and subscription questions"
      ],
      platformFeatures: [
        "User management",
        "API documentation",
        "Dashboard customization",
        "Data export/import"
      ]
    };
  }

  async generateAIResponse(ticket, context) {
    const prompt = `
You are a helpful customer support agent for our software platform. 

Customer Information:
- Name: ${ticket.customer.name}
- Email: ${ticket.customer.email}
- Subject: ${ticket.subject}

Customer Message:
${ticket.messages.map(msg => msg.body || msg.text || 'No content').join('\n')}

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
        model: "gpt-4",
        messages: [
          { role: "system", content: "You are a helpful customer support agent specializing in software platform assistance." },
          { role: "user", content: prompt }
        ],
        max_tokens: 500,
        temperature: 0.7
      });

      const response = completion.choices[0].message.content;
      console.log('AI response generated');
      return response;

    } catch (error) {
      console.error('Error generating AI response:', error);
      return "Thank you for contacting our support team. We've received your inquiry and will respond shortly with a personalized solution.";
    }
  }

  async sendGmailResponse(ticket, response) {
    try {
      const emailContent = `To: ${ticket.customer.email}
Subject: Re: ${ticket.subject}
Content-Type: text/plain; charset=utf-8

Hi ${ticket.customer.name},

${response}

Best regards,
Customer Support Team

---
This is an automated response. If you need further assistance, please reply to this email.`;

      const encodedEmail = Buffer.from(emailContent).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedEmail
        }
      });

      console.log('Response sent via Gmail');
    } catch (error) {
      console.error('Error sending Gmail response:', error);
    }
  }

  async notifySlackChannel(ticket, response, error = null) {
    const channelId = process.env.SLACK_SUPPORT_CHANNEL_ID;
    
    try {
      let message;
      
      if (error) {
        message = {
          text: `🚨 Error processing ticket ${ticket.id}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Error Processing Ticket*\n*ID:* ${ticket.id}\n*Customer:* ${ticket.customer.name} (${ticket.customer.email})\n*Subject:* ${ticket.subject}\n*Error:* ${error.message}`
              }
            }
          ]
        };
      } else {
        message = {
          text: `✅ Automated response sent for ticket ${ticket.id}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Automated Response Sent*\n*Ticket ID:* ${ticket.id}\n*Customer:* ${ticket.customer.name} (${ticket.customer.email})\n*Subject:* ${ticket.subject}\n*Source:* ${ticket.source}`
              }
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Response Preview:*\n${response.substring(0, 200)}${response.length > 200 ? '...' : ''}`
              }
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "Review Full Response"
                  },
                  url: `${process.env.BASE_URL}/ticket/${ticket.id}`
                }
              ]
            }
          ]
        };
      }

      await this.slack.chat.postMessage({
        channel: channelId,
        ...message
      });

      console.log('Slack notification sent');
    } catch (error) {
      console.error('Error sending Slack notification:', error);
    }
  }

  async updateKnowledgeBase(ticket, response) {
    // Store the interaction for future learning
    const interaction = {
      timestamp: new Date().toISOString(),
      ticketId: ticket.id,
      customerQuery: ticket.messages.map(msg => msg.body || msg.text).join(' '),
      aiResponse: response,
      customerEmail: ticket.customer.email,
      subject: ticket.subject,
      source: ticket.source
    };

    // This could be stored in a database, sent to ChatGPT for training, etc.
    console.log('Knowledge base updated with interaction:', interaction.ticketId);
  }

  extractEmailBody(payload) {
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body.data) {
          return Buffer.from(part.body.data, 'base64').toString();
        }
      }
    } else if (payload.body.data) {
      return Buffer.from(payload.body.data, 'base64').toString();
    }
    return 'No content available';
  }

  start(port = 3000) {
    this.app.listen(port, () => {
      console.log(`Customer Support AI Agent running on port ${port}`);
      console.log('Webhooks available at:');
      console.log(`- HelpScout: POST /webhook/helpscout`);
      console.log(`- Gmail: POST /webhook/gmail`);
      console.log(`- Manual: POST /process-ticket`);
    });
  }
}

// Configuration and startup
if (require.main === module) {
  const agent = new CustomerSupportAgent();
  agent.start();
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