const db = require('../config/db');
const { sendLeadAssignmentEmail } = require('../services/brevoService');
const { sendWhatsAppTemplateMessage } = require('../services/whatsappNotfinoService');
const {
  normalizePhoneForWhatsApp,
  createLeadAssignmentPayload,
} = require('../utils/whatsappTemplatePayloads');

/* =====================================================
   SEND LEAD ASSIGNMENT EMAIL (Using Brevo)
===================================================== */
const sendEmail = async (req, res) => {
  const {
    first_name,
    last_name,
    email,
    phone_number,
    company_name,
    lead_status,
    priority,
    follow_up_date,
    assigned_salesperson,
    custom_fields,
    amount,
    notes,
    salesperson_email,
  } = req.body;

  if (!salesperson_email) {
    return res.status(400).json({
      success: false,
      message: "Recipient email is required",
    });
  }

  try {
    let salespersonName = assigned_salesperson;

    if (assigned_salesperson && /^\d+$/.test(String(assigned_salesperson))) {
      const [rows] = await db.query(
        `SELECT name FROM users WHERE id = ? LIMIT 1`,
        [Number(assigned_salesperson)]
      );

      if (rows.length && rows[0].name) {
        salespersonName = rows[0].name;
      }
    }

    if (!salespersonName && salesperson_email) {
      salespersonName = String(salesperson_email).split('@')[0];
    }

    await sendLeadAssignmentEmail({
      salesperson_email,
      salesperson_name: salespersonName,
      lead_data: {
        first_name,
        last_name,
        email,
        phone_number,
        company_name,
        lead_status,
        priority,
        follow_up_date,
        amount,
        notes,
        custom_fields
      }
    });

    return res.status(200).json({
      success: true,
      message: "Email sent successfully via Brevo",
    });

  } catch (error) {
    console.error("BREVO EMAIL ERROR:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to send email",
    });
  }
};

const sendWhatsApp = async (req, res) => {
  const {
    first_name,
    last_name,
    company_name,
    email,
    phone_number,
    lead_status,
    priority,
    follow_up_date,
    assigned_salesperson,
    amount,
    salesperson_phone_number,
  } = req.body;

  try {
    let salespersonName = assigned_salesperson;
    let salespersonPhone = salesperson_phone_number || null;

    if (assigned_salesperson && /^\d+$/.test(String(assigned_salesperson))) {
      const [rows] = await db.query(
        `SELECT name, phone_number FROM users WHERE id = ? LIMIT 1`,
        [Number(assigned_salesperson)]
      );

      if (rows.length) {
        salespersonName = rows[0].name || salespersonName;
        salespersonPhone = rows[0].phone_number || salespersonPhone;
      }
    }

    const formattedPhone = normalizePhoneForWhatsApp(salespersonPhone);

    if (!formattedPhone) {
      return res.status(400).json({
        success: false,
        message: 'Recipient WhatsApp number is required',
      });
    }

    if (!salespersonName && formattedPhone) {
      salespersonName = `Salesperson ${formattedPhone.slice(-4)}`;
    }

    const result = await sendWhatsAppTemplateMessage(
      createLeadAssignmentPayload({
        phoneNumber: formattedPhone,
        salespersonName: salespersonName || 'Salesperson',
        lead: {
          name: `${first_name || ''} ${last_name || ''}`.trim() || 'Lead',
          email,
          phone: phone_number,
          company: company_name,
          status: lead_status,
          priority,
          followUpDate: follow_up_date,
          amount: amount !== undefined && amount !== null ? String(amount) : '-',
        },
      })
    );

    return res.status(200).json({
      success: true,
      message: 'WhatsApp notification sent successfully',
      data: result,
    });
  } catch (error) {
    console.error('WHATSAPP ERROR:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to send WhatsApp notification',
    });
  }
};

module.exports = { sendEmail, sendWhatsApp };
