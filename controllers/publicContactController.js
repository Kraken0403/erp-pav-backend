const { sendBrevoEmail, renderUnifiedEmailTemplate } = require('../services/brevoService');

/**
 * Public contact form handler.
 * Sends an email to configured admin/owner addresses without creating a lead.
 */
async function createContact(req, res) {
  try {
    const body = req.body || {};
    const name = String(body.name || body.first_name || '').trim();
    const email = String(body.email || '').trim();
    const phone = String(body.phone || body.phone_number || '').trim();
    const message = String(body.message || body.notes || '').trim();
    const subject = String(body.subject || `Website contact from ${name || email || 'visitor'}`).trim();

    if (!email || !message) {
      return res.status(400).json({ error: 'Missing required fields: email and message' });
    }

    // Resolve recipients from env: CONTACT_RECIPIENTS (comma separated) or CONTACT_RECIPIENT
    const rawRecipients = String(process.env.CONTACT_RECIPIENTS || process.env.CONTACT_RECIPIENT || '').trim();
    const recipients = rawRecipients
      ? rawRecipients.split(',').map(s => String(s || '').trim()).filter(Boolean)
      : [];

    if (!recipients.length) {
      const fallback = String(process.env.MAIL_TO_ADMIN || process.env.MAIL_FROM_EMAIL || '').trim();
      if (fallback) recipients.push(fallback);
    }

    if (!recipients.length) {
      console.warn('Public contact submission received but no recipient configured');
      return res.status(500).json({ error: 'Contact endpoint not configured' });
    }

    const rows = [
      { label: 'Name', value: name || '—' },
      { label: 'Email', value: email },
      { label: 'Phone', value: phone || '—' },
    ].filter(r => r.value !== undefined && r.value !== null);

    // Determine a friendly site identifier for the email subtitle. Prefer the
    // request Referer or Origin (frontend), then configured env vars.
    const referer = String(req.headers['referer'] || req.headers['referrer'] || '').trim();
    const origin = String(req.headers['origin'] || '').trim();
      const configured = String(process.env.FRONTEND_URL || process.env.SITE_PUBLIC_URL || process.env.MAIL_PREVIEW_BASE_URL || process.env.FEEDBACK_FORM_BASE_URL ||'').trim();
    let siteDisplay = 'Website';
    if (referer) {
      try {
        const u = new URL(referer);
        siteDisplay = u.host || referer;
      } catch {
        siteDisplay = referer;
      }
    } else if (origin) {
      try {
        const u = new URL(origin);
        siteDisplay = u.host || origin;
      } catch {
        siteDisplay = origin;
      }
    } else if (configured) {
      try {
        const u = new URL(configured);
        siteDisplay = u.host || configured;
      } catch {
        siteDisplay = configured;
      }
    }

    const htmlContent = renderUnifiedEmailTemplate({
      title: 'New Contact Form Submission',
      subtitle: `From website: ${siteDisplay}`,
      greeting: 'Hello',
      intro: `A visitor submitted the contact form.`,
      rows,
      table: null,
      cta: null,
      outro: [`Message:`, message],
    });

    const results = [];
    for (const to of recipients) {
      try {
        const r = await sendBrevoEmail({
          to,
          toName: null,
          subject,
          htmlContent,
        });
        results.push({ to, ok: true, info: r?.messageId || r });
      } catch (e) {
        console.error('Failed to send contact email to', to, e && e.message ? e.message : e);
        results.push({ to, ok: false, error: e && e.message ? e.message : String(e) });
      }
    }

    return res.status(200).json({ success: true, results });
  } catch (err) {
    console.error('createContact error:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Failed to process contact submission' });
  }
}

module.exports = {
  createContact,
};
