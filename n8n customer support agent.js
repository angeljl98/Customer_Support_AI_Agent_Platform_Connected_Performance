async notifySlackChannel(ticket, response, error = null) {
  const channelId = process.env.SLACK_SUPPORT_CHANNEL_ID;
  const replyFormBase = process.env.N8N_REPLY_FORM_URL; // URL base del formulario de n8n

  // Construimos la URL del formulario con parámetros del ticket
  let replyUrl = null;
  if (replyFormBase) {
    const params = new URLSearchParams({
      ticketId: (ticket?.id || '').toString(),
      name: ticket?.customer?.name || '',
      email: ticket?.customer?.email || '',
      subject: ticket?.subject || '',
      source: ticket?.source || '',
    });
    replyUrl = `${replyFormBase}?${params.toString()}`;
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
      const customerMessage = (
        (ticket?.messages?.[0]?.body || ticket?.messages?.[0]?.text || '') + ''
      ).slice(0, 500);

      const preview = (response || '').slice(0, 200) +
        ((response || '').length > 200 ? '...' : '');

      const blocks = [
        {
          // 👇 QUITAMOS "Automated Response Sent" y usamos "New Support Ticket"
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `*New Support Ticket*\n` +
              `*Ticket ID:* ${ticket?.id}\n` +
              `*Customer:*
