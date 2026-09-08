const db = require("../config/db");
const { addOrUpdateCustomFields } = require("./customFieldValues");
const {
  createNotificationsForUsers,
  getAdminUserIds,
  getSystemNotifierUserId,
  resolveUserIdByAssignment,
} = require("../services/notificationService");

const ensureLeadCompanySchema = async (connection = db) => {
  const [columns] = await connection.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads'");
  const existing = new Set(columns.map((row) => String(row.COLUMN_NAME).toLowerCase()));
  if (!existing.has('company_id')) await connection.query('ALTER TABLE leads ADD COLUMN company_id INT NULL');
  if (!existing.has('designation')) await connection.query('ALTER TABLE leads ADD COLUMN designation VARCHAR(150) NULL');
};

// Helper to normalize datetime without timezone shifting
const normalizeDateTime = (value) => {
  if (!value) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw} 00:00:00`;
  }

  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(raw)) {
    return raw.replace("T", " ") + ":00";
  }

  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(raw)) {
    return raw.replace("T", " ");
  }

  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) return null;

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  const seconds = String(parsed.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

const hasValue = (value) =>
  value !== undefined && value !== null && String(value).trim() !== "";
const pickDefined = (value, fallback) =>
  value === undefined ? fallback : value;

const toDateOnlyString = (value) => {
  if (!hasValue(value)) return null;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const toTimeOnlyString = (value) => {
  if (!hasValue(value)) return null;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{2}:\d{2})(?::\d{2})?$/);
  if (match) return `${match[1]}:00`;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  const seconds = String(parsed.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
};

const toModeFlag = (value) => {
  if (value === undefined || value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value === 1 ? 1 : 0;

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return 1;
  return 0;
};

const splitFullName = (fullName = "") => {
  const cleaned = String(fullName).trim().replace(/\s+/g, " ");
  if (!cleaned) {
    return { firstName: null, lastName: null };
  }

  const [firstName, ...rest] = cleaned.split(" ");
  return {
    firstName: firstName || null,
    lastName: rest.length ? rest.join(" ") : null,
  };
};

const isCateringBusiness = async (connection) => {
  const [rows] = await connection.query(
    `SELECT business_type FROM settings WHERE id = 1 LIMIT 1`,
  );

  const businessType = String(rows?.[0]?.business_type || "GENERAL")
    .trim()
    .toUpperCase();
  return businessType === "CATERING";
};

const getWebsiteInquiryFollowUpDateTime = (referenceDate = new Date()) => {
  const now =
    referenceDate instanceof Date ? referenceDate : new Date(referenceDate);

  if (Number.isNaN(now.getTime())) {
    return null;
  }

  const hours = now.getHours();
  const minutes = now.getMinutes();
  const isWithinBusinessWindow =
    (hours > 9 && hours < 17) ||
    (hours === 9 && minutes >= 0) ||
    (hours === 17 && minutes === 0);

  if (isWithinBusinessWindow) {
    const plus24 = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return normalizeDateTime(plus24);
  }

  const nextDay430pm = new Date(now);
  nextDay430pm.setDate(nextDay430pm.getDate() + 1);
  nextDay430pm.setHours(16, 30, 0, 0);

  return normalizeDateTime(nextDay430pm);
};

/* ============================================================
   CREATE LEAD (WITH TRANSACTION)
============================================================ */
exports.createLead = async (req, res) => {
  const {
    name,
    first_name,
    last_name,
    company_name,
    company_id,
    designation,
    lead_status,
    email,
    phone,
    phone_number,
    gst_number,
    contact_name,
    follow_up_date,
    priority,
    assigned_salesperson,
    hotness,
    amount,
    notes,
    custom_fields = [],
    shipping_address,
    shipping_landmark,
    shipping_city,
    shipping_state,
    shipping_pincode,
    billing_address,
    billing_landmark,
    billing_city,
    billing_state,
    billing_pincode,
    source,
    event_type,
    event_date,
    event_time,
    event_start_date,
    event_start_time,
    event_end_date,
    event_end_time,
    event_location,
    pax,
    product_id,
    product_name,
  } = req.body;
  console.log("CREATE LEAD PAYLOAD:", req.body);

  const created_by = req.user?.username || "None";

  const splitName = splitFullName(name);
  const finalFirstName = hasValue(first_name)
    ? first_name
    : splitName.firstName;
  const finalLastName = hasValue(last_name) ? last_name : splitName.lastName;
  const finalPhoneNumber = hasValue(phone_number) ? phone_number : phone;
  const finalContactName = hasValue(contact_name) ? contact_name : name || null;
  const finalCompanyName = hasValue(company_name) ? company_name : null;
  const finalLeadStatus = hasValue(lead_status) ? lead_status : "New";
  let finalEventType = null;
  let finalEventStartDate = null;
  let finalEventTime = null;
  let finalEventStartTime = null; // ✅ add this
  let finalEventEndDate = null; // ✅ add this
  let finalEventEndTime = null;
  let finalEventLocation = null;
  let finalPax = null;
  let finalProductId = null;
  let finalProductName = null;

  let normalizedFollowUpDate = normalizeDateTime(follow_up_date);

  const finalNotes = hasValue(notes) ? String(notes).trim() : null;

  const isEventStylePayload =
    hasValue(name) ||
    hasValue(event_type) ||
    hasValue(event_start_date) ||
    hasValue(event_date) ||
    hasValue(event_time) ||
    hasValue(event_location) ||
    hasValue(pax) ||
    hasValue(product_id) ||
    hasValue(product_name);

  // ✅ NEVER allow NULL source
  const safeSource =
    source && source.trim() !== ""
      ? source
      : isEventStylePayload
        ? "WEB_LEAD"
        : "CRM";

  const isWebsiteInquirySource = String(safeSource || "")
    .toLowerCase()
    .includes("website");

  if (isWebsiteInquirySource && !hasValue(follow_up_date)) {
    normalizedFollowUpDate = getWebsiteInquiryFollowUpDateTime(new Date());
  }

  let connection;

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    await ensureLeadCompanySchema(connection);

    const cateringEnabled = await isCateringBusiness(connection);

    if (cateringEnabled) {
      finalEventType = hasValue(event_type) ? event_type : null;
      finalEventStartDate = toDateOnlyString(event_start_date || event_date);
      finalEventTime = toTimeOnlyString(event_time);
      finalEventStartTime = toTimeOnlyString(event_start_time || event_time);
      finalEventEndDate = toDateOnlyString(event_end_date);
      finalEventEndTime = toTimeOnlyString(event_end_time);
      finalEventLocation = hasValue(event_location) ? event_location : null;
      finalPax = hasValue(pax) ? Number(pax) : null;
      finalProductId = hasValue(product_id) ? Number(product_id) : null;
      finalProductName = hasValue(product_name) ? product_name : null;

      const shouldDeriveFollowUpFromEvent = !String(safeSource || "")
        .toLowerCase()
        .includes("website");

      if (
        !hasValue(follow_up_date) &&
        finalEventStartDate &&
        shouldDeriveFollowUpFromEvent
      ) {
        normalizedFollowUpDate = normalizeDateTime(
          `${finalEventStartDate} ${finalEventStartTime || finalEventTime || "00:00:00"}`,
        );
      }
    }

    // Dynamically detect actual `leads` table columns and build INSERT accordingly
    const [colRows] = await connection.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads'",
    );
    const actualCols = new Set(
      (colRows || []).map((r) => String(r.COLUMN_NAME).toLowerCase()),
    );

    const desiredOrder = [
      "first_name",
      "last_name",
      "company_name",
      "company_id",
      "designation",
      "lead_status",
      "email",
      "phone_number",
      "gst_number",
      "contact_name",
      "follow_up_date",
      "priority",
      "assigned_salesperson",
      "hotness",
      "amount",
      "notes",
      "created_by",
      "shipping_address",
      "shipping_landmark",
      "shipping_city",
      "shipping_state",
      "shipping_pincode",
      "billing_address",
      "billing_landmark",
      "billing_city",
      "billing_state",
      "billing_pincode",
      "source",
      // include all possible event-related column names so we map to whichever exists
      "event_type",
      "event_date",
      "event_time",
      "event_start_date",
      "event_start_time",
      "event_end_date",
      "event_end_time",
      "event_location",
      "pax",
      "product_id",
      "product_name",
    ];

    const columns = desiredOrder.filter((c) => actualCols.has(c));

    const paramMap = {
      first_name: finalFirstName,
      last_name: finalLastName,
      company_name: finalCompanyName,
      company_id: company_id || null,
      designation: designation || null,
      lead_status: finalLeadStatus,
      email: email,
      phone_number: finalPhoneNumber,
      gst_number: gst_number,
      contact_name: finalContactName,
      follow_up_date: normalizedFollowUpDate,
      priority: priority,
      assigned_salesperson: assigned_salesperson,
      hotness: hotness,
      amount: amount,
      notes: finalNotes,
      created_by: created_by,
      shipping_address: shipping_address,
      shipping_landmark: shipping_landmark,
      shipping_city: shipping_city,
      shipping_state: shipping_state,
      shipping_pincode: shipping_pincode,
      billing_address: billing_address,
      billing_landmark: billing_landmark,
      billing_city: billing_city,
      billing_state: billing_state,
      billing_pincode: billing_pincode,
      source: safeSource,
      event_type: finalEventType,
      event_date: finalEventStartDate,
      event_time: finalEventTime,
      event_start_date: finalEventStartDate,
      event_start_time: finalEventStartTime,
      event_end_date: finalEventEndDate,
      event_end_time: finalEventEndTime,
      event_location: finalEventLocation,
      pax: finalPax,
      product_id: finalProductId,
      product_name: finalProductName,
    };

    const insertParams = columns.map((c) =>
      paramMap[c] !== undefined ? paramMap[c] : null,
    );

    const placeholders = Array(columns.length).fill("?").join(", ");
    const builtSql = `INSERT INTO leads (${columns.join(", ")}) VALUES (${placeholders})`;

    console.debug(
      "create-lead: builtSql columns=",
      columns.length,
      "params=",
      insertParams.length,
    );

    const [result] = await connection.query(builtSql, insertParams);

    const leadId = result.insertId;
    const leadDisplayName =
      [finalFirstName, finalLastName]
        .filter((part) => hasValue(part))
        .join(" ")
        .trim() ||
      finalContactName ||
      "Lead";

    if (custom_fields.length) {
      await addOrUpdateCustomFields(leadId, custom_fields, connection);
    }

    const actorUserId =
      Number(req.user?.id || 0) || (await getSystemNotifierUserId(connection));
    if (Number.isInteger(actorUserId) && actorUserId > 0) {
      const adminUserIds = await getAdminUserIds(connection);

      await createNotificationsForUsers({
        byUserId: actorUserId,
        toUserIds: adminUserIds,
        module: "leads",
        action: `Lead Created - ${leadDisplayName}`,
        sourceId: leadId,
        redirectUrl: `/leads/${leadId}/edit`,
        connection,
      });

      const assignedUserId = await resolveUserIdByAssignment(
        assigned_salesperson,
        connection,
      );
      if (assignedUserId && assignedUserId !== actorUserId) {
        await createNotificationsForUsers({
          byUserId: actorUserId,
          toUserIds: [assignedUserId],
          module: "leads",
          action: `Lead Assigned - ${leadDisplayName}`,
          sourceId: leadId,
          redirectUrl: `/leads/${leadId}/edit`,
          connection,
        });
      }
    }

    await connection.commit();

    return res.status(201).json({
      message: "Lead created successfully",
      leadId,
    });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("CREATE LEAD ERROR:", err);
    return res.status(500).json({
      error: "Failed to create lead",
      details: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

/* ============================================================
   GET ALL LEADS
============================================================ */
exports.getAllLeads = async (req, res) => {
  try {
    await ensureLeadCompanySchema(db);
    const [leads] = await db.query("SELECT * FROM leads");

    if (!leads.length) {
      return res.status(200).json({ leads: [] });
    }

    const leadIds = leads.map((l) => l.id);

    const [fields] = await db.query(
      "SELECT * FROM lead_field_values WHERE lead_id IN (?)",
      [leadIds],
    );

    const leadsWithFields = leads.map((lead) => ({
      ...lead,
      custom_fields: fields.filter((f) => f.lead_id === lead.id),
    }));

    return res.status(200).json({ leads: leadsWithFields });
  } catch (err) {
    console.error("GET ALL LEADS ERROR:", err);
    return res.status(500).json({
      error: "Failed to fetch leads",
      details: err.message,
    });
  }
};

/* ============================================================
   GET LEADS FOR AUTHENTICATED USER
   Returns leads where email matches the authenticated user's email.
   Protected by auth middleware in route registration.
============================================================ */
exports.getLeadsForUser = async (req, res) => {
  try {
    const userId = Number(req.user?.id || 0);
    if (!userId) return res.status(401).json({ error: "Unauthenticated" });

    const [[userRow]] = await db.query(
      "SELECT email FROM users WHERE id = ? LIMIT 1",
      [userId],
    );
    const userEmail = userRow?.email || null;

    if (!userEmail) return res.status(200).json({ leads: [] });

    const [leads] = await db.query(
      "SELECT * FROM leads WHERE email = ? ORDER BY id DESC",
      [userEmail],
    );

    if (!leads.length) return res.status(200).json({ leads: [] });

    const leadIds = leads.map((l) => l.id);

    const [fields] = await db.query(
      "SELECT * FROM lead_field_values WHERE lead_id IN (?)",
      [leadIds],
    );

    const leadsWithFields = leads.map((lead) => ({
      ...lead,
      custom_fields: fields.filter((f) => f.lead_id === lead.id),
    }));

    return res.status(200).json({ leads: leadsWithFields });
  } catch (err) {
    console.error("getLeadsForUser ERROR:", err);
    return res
      .status(500)
      .json({ error: "Failed to fetch user leads", details: err.message });
  }
};

/* ============================================================
   GET LEAD BY ID
============================================================ */
exports.getLeadById = async (req, res) => {
  try {
    await ensureLeadCompanySchema(db);
    const { id } = req.params;

    const [rows] = await db.query("SELECT * FROM leads WHERE id = ?", [id]);

    if (!rows.length) {
      return res.status(404).json({ message: "Lead not found" });
    }

    const lead = rows[0];

    const [customFields] = await db.query(
      "SELECT * FROM lead_field_values WHERE lead_id = ?",
      [id],
    );

    lead.custom_fields = customFields;

    return res.status(200).json(lead);
  } catch (err) {
    console.error("GET LEAD ERROR:", err);
    return res.status(500).json({
      error: "Failed to fetch lead",
      details: err.message,
    });
  }
};

/* ============================================================
   UPDATE LEAD (WITH TRANSACTION)
============================================================ */
exports.updateLead = async (req, res) => {
  const { id } = req.params;

  const {
    name,
    first_name,
    last_name,
    company_name,
    company_id,
    designation,
    lead_status,
    email,
    phone,
    phone_number,
    gst_number,
    contact_name,
    follow_up_date,
    priority,
    assigned_salesperson,
    hotness,
    amount,
    notes,
    custom_fields = [],
    shipping_address,
    shipping_landmark,
    shipping_city,
    shipping_state,
    shipping_pincode,
    billing_address,
    billing_landmark,
    billing_city,
    billing_state,
    billing_pincode,
    source,
    event_type,
    event_date,
    event_time,
    event_start_date,
    event_start_time,
    event_end_date,
    event_end_time,
    event_location,
    pax,
    product_id,
    product_name,
    is_catering_mode,
    catering_mode,
  } = req.body;

  let connection;

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    await ensureLeadCompanySchema(connection);

    // ✅ Get existing source first
    const [[existingLead]] = await connection.query(
      `SELECT * FROM leads WHERE id = ?`,
      [id],
    );

    if (!existingLead) {
      await connection.rollback();
      return res.status(404).json({ message: "Lead not found" });
    }

    // ✅ Preserve old source if not provided
    const safeSource =
      source && source.trim() !== "" ? source : existingLead.source || "CRM";

    const splitName = splitFullName(name);

    const resolvedFirstName =
      first_name !== undefined
        ? first_name
        : hasValue(name)
          ? splitName.firstName
          : undefined;
    const resolvedLastName =
      last_name !== undefined
        ? last_name
        : hasValue(name)
          ? splitName.lastName
          : undefined;
    const resolvedPhoneNumber =
      phone_number !== undefined ? phone_number : phone;
    const resolvedContactName =
      contact_name !== undefined
        ? contact_name
        : hasValue(name)
          ? name
          : undefined;

    const finalFirstName = pickDefined(
      resolvedFirstName,
      existingLead.first_name,
    );
    const finalLastName = pickDefined(resolvedLastName, existingLead.last_name);
    const finalCompanyName = pickDefined(
      company_name,
      existingLead.company_name,
    );
    const finalCompanyId = pickDefined(company_id, existingLead.company_id);
    const finalDesignation = pickDefined(designation, existingLead.designation);
    const finalLeadStatus = pickDefined(lead_status, existingLead.lead_status);
    const finalEmail = pickDefined(email, existingLead.email);
    const finalPhoneNumber = pickDefined(
      resolvedPhoneNumber,
      existingLead.phone_number,
    );
    const finalGstNumber = pickDefined(gst_number, existingLead.gst_number);
    const finalContactName = pickDefined(
      resolvedContactName,
      existingLead.contact_name,
    );
    const finalPriority = pickDefined(priority, existingLead.priority);
    const finalAssignedSalesperson = pickDefined(
      assigned_salesperson,
      existingLead.assigned_salesperson,
    );
    const finalHotness = pickDefined(hotness, existingLead.hotness);
    const finalAmount = pickDefined(amount, existingLead.amount);
    const finalNotes = pickDefined(notes, existingLead.notes);

    const finalShippingAddress = pickDefined(
      shipping_address,
      existingLead.shipping_address,
    );
    const finalShippingLandmark = pickDefined(
      shipping_landmark,
      existingLead.shipping_landmark,
    );
    const finalShippingCity = pickDefined(
      shipping_city,
      existingLead.shipping_city,
    );
    const finalShippingState = pickDefined(
      shipping_state,
      existingLead.shipping_state,
    );
    const finalShippingPincode = pickDefined(
      shipping_pincode,
      existingLead.shipping_pincode,
    );

    const finalBillingAddress = pickDefined(
      billing_address,
      existingLead.billing_address,
    );
    const finalBillingLandmark = pickDefined(
      billing_landmark,
      existingLead.billing_landmark,
    );
    const finalBillingCity = pickDefined(
      billing_city,
      existingLead.billing_city,
    );
    const finalBillingState = pickDefined(
      billing_state,
      existingLead.billing_state,
    );
    const finalBillingPincode = pickDefined(
      billing_pincode,
      existingLead.billing_pincode,
    );

    const modeInput =
      is_catering_mode !== undefined ? is_catering_mode : catering_mode;
    const finalIsCateringMode =
      modeInput !== undefined
        ? toModeFlag(modeInput)
        : hasValue(existingLead.event_type) ||
            hasValue(existingLead.event_start_date) ||
            hasValue(existingLead.event_date) ||
            hasValue(existingLead.event_time) ||
            hasValue(existingLead.event_location) ||
            hasValue(existingLead.pax) ||
            hasValue(existingLead.product_id) ||
            hasValue(existingLead.product_name)
          ? 1
          : 0;

    const finalEventType = finalIsCateringMode
      ? pickDefined(event_type, existingLead.event_type)
      : null;
    const finalEventTime = finalIsCateringMode
      ? event_time !== undefined
        ? toTimeOnlyString(event_time)
        : existingLead.event_time
      : null;
    const finalEventStartDate = finalIsCateringMode
      ? event_start_date !== undefined
        ? toDateOnlyString(event_start_date)
        : existingLead.event_start_date || existingLead.event_date
      : null;
    const finalEventStartTime = finalIsCateringMode
      ? event_start_time !== undefined
        ? toTimeOnlyString(event_start_time)
        : existingLead.event_start_time
      : null;
    const finalEventEndDate = finalIsCateringMode
      ? event_end_date !== undefined
        ? toDateOnlyString(event_end_date)
        : existingLead.event_end_date
      : null;
    const finalEventEndTime = finalIsCateringMode
      ? event_end_time !== undefined
        ? toTimeOnlyString(event_end_time)
        : existingLead.event_end_time
      : null;
    const finalEventLocation = finalIsCateringMode
      ? pickDefined(event_location, existingLead.event_location)
      : null;
    const finalPax = finalIsCateringMode
      ? pax !== undefined
        ? hasValue(pax)
          ? Number(pax)
          : null
        : existingLead.pax
      : null;
    const finalProductId = finalIsCateringMode
      ? product_id !== undefined
        ? hasValue(product_id)
          ? Number(product_id)
          : null
        : existingLead.product_id
      : null;
    const finalProductName = finalIsCateringMode
      ? pickDefined(product_name, existingLead.product_name)
      : null;

    const shouldDeriveFollowUpFromEvent =
      finalIsCateringMode &&
      finalEventStartDate &&
      !String(safeSource || "")
        .toLowerCase()
        .includes("website");

    const derivedFollowUpDate =
      follow_up_date !== undefined
        ? follow_up_date
        : shouldDeriveFollowUpFromEvent
          ? `${finalEventStartDate} ${finalEventStartTime || finalEventTime || "00:00:00"}`
          : existingLead.follow_up_date;

    const normalizedFollowUpDate = normalizeDateTime(derivedFollowUpDate);

    const [result] = await connection.query(
      `
      UPDATE leads SET
        first_name = ?, 
        last_name = ?, 
        company_name = ?, 
        company_id = ?,
        designation = ?,
        lead_status = ?, 
        email = ?, 
        phone_number = ?, 
        gst_number = ?, 
        contact_name = ?, 
        follow_up_date = ?, 
        priority = ?, 
        assigned_salesperson = ?, 
        hotness = ?, 
        amount = ?, 
        notes = ?,
        shipping_address = ?, 
        shipping_landmark = ?, 
        shipping_city = ?, 
        shipping_state = ?, 
        shipping_pincode = ?,
        billing_address = ?, 
        billing_landmark = ?, 
        billing_city = ?, 
        billing_state = ?, 
        billing_pincode = ?,
        source = ?,
        event_type = ?,
        event_time = ?,
        event_start_date = ?,
        event_start_time = ?,
        event_end_date = ?,
        event_end_time = ?,
        event_location = ?,
        pax = ?,
        product_id = ?,
        product_name = ?
      WHERE id = ?
      `,
      [
        finalFirstName,
        finalLastName,
        finalCompanyName,
        finalCompanyId || null,
        finalDesignation,
        finalLeadStatus,
        finalEmail,
        finalPhoneNumber,
        finalGstNumber,
        finalContactName,
        normalizedFollowUpDate,
        finalPriority,
        finalAssignedSalesperson,
        finalHotness,
        finalAmount,
        finalNotes,
        finalShippingAddress,
        finalShippingLandmark,
        finalShippingCity,
        finalShippingState,
        finalShippingPincode,
        finalBillingAddress,
        finalBillingLandmark,
        finalBillingCity,
        finalBillingState,
        finalBillingPincode,
        safeSource,
        finalEventType,
        finalEventTime,
        finalEventStartDate,
        finalEventStartTime,
        finalEventEndDate,
        finalEventEndTime,
        finalEventLocation,
        finalPax,
        finalProductId,
        finalProductName,
        id,
      ],
    );

    if (!result.affectedRows) {
      await connection.rollback();
      return res.status(404).json({ message: "Lead not found" });
    }

    if (custom_fields.length) {
      await addOrUpdateCustomFields(id, custom_fields, connection);
    }

    const actorUserId = Number(req.user?.id || 0);
    if (Number.isInteger(actorUserId) && actorUserId > 0) {
      const leadId = Number(id);
      const previousAssigned = existingLead.assigned_salesperson;
      const previousStatus = String(existingLead.lead_status || "");
      const finalStatus = String(finalLeadStatus || "");

      const newAssignedUserId = await resolveUserIdByAssignment(
        finalAssignedSalesperson,
        connection,
      );
      const previousAssignedUserId = await resolveUserIdByAssignment(
        previousAssigned,
        connection,
      );

      if (
        newAssignedUserId &&
        newAssignedUserId !== previousAssignedUserId &&
        newAssignedUserId !== actorUserId
      ) {
        await createNotificationsForUsers({
          byUserId: actorUserId,
          toUserIds: [newAssignedUserId],
          module: "leads",
          action: "Lead Assigned",
          sourceId: leadId,
          redirectUrl: `/leads/${leadId}/edit`,
          connection,
        });
      }

      if (finalStatus && finalStatus !== previousStatus) {
        const statusRecipients = newAssignedUserId
          ? [newAssignedUserId]
          : await getAdminUserIds(connection);

        await createNotificationsForUsers({
          byUserId: actorUserId,
          toUserIds: statusRecipients,
          module: "leads",
          action: `Lead Status Updated (${previousStatus || "unknown"} -> ${finalStatus})`,
          sourceId: leadId,
          redirectUrl: `/leads/${leadId}/edit`,
          connection,
        });
      }
    }

    await connection.commit();

    return res.status(200).json({
      message: "Lead and custom fields updated successfully",
    });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("UPDATE LEAD ERROR:", err);
    return res.status(500).json({
      error: "Failed to update lead",
      details: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

/* ============================================================
   DELETE LEAD (WITH TRANSACTION)
============================================================ */
exports.deleteLead = async (req, res) => {
  const { id } = req.params;

  let connection;

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    await connection.query("DELETE FROM lead_field_values WHERE lead_id = ?", [
      id,
    ]);

    const [result] = await connection.query("DELETE FROM leads WHERE id = ?", [
      id,
    ]);

    if (!result.affectedRows) {
      await connection.rollback();
      return res.status(404).json({ message: "Lead not found" });
    }

    await connection.commit();

    return res.status(200).json({
      message: "Lead and related custom fields deleted successfully",
    });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("DELETE LEAD ERROR:", err);
    return res.status(500).json({
      error: "Failed to delete lead",
      details: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

/* ============================================================
   BULK DELETE LEADS (WITH TRANSACTION)
============================================================ */
exports.bulkDeleteLeads = async (req, res) => {
  const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const leadIds = [
    ...new Set(
      rawIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];

  if (!leadIds.length) {
    return res.status(400).json({ error: "Valid lead ids are required" });
  }

  let connection;

  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const placeholders = leadIds.map(() => "?").join(",");

    const [existingRows] = await connection.query(
      `SELECT id FROM leads WHERE id IN (${placeholders})`,
      leadIds,
    );

    const existingIds = existingRows.map((row) => Number(row.id));

    if (!existingIds.length) {
      await connection.rollback();
      return res.status(404).json({ message: "No leads found for deletion" });
    }

    const existingPlaceholders = existingIds.map(() => "?").join(",");

    await connection.query(
      `DELETE FROM lead_field_values WHERE lead_id IN (${existingPlaceholders})`,
      existingIds,
    );

    const [deleteResult] = await connection.query(
      `DELETE FROM leads WHERE id IN (${existingPlaceholders})`,
      existingIds,
    );

    await connection.commit();

    return res.status(200).json({
      message: "Leads and related custom fields deleted successfully",
      deleted_count: Number(deleteResult?.affectedRows || 0),
      deleted_ids: existingIds,
      not_found_ids: leadIds.filter((id) => !existingIds.includes(id)),
    });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("BULK DELETE LEADS ERROR:", err);
    return res.status(500).json({
      error: "Failed to delete leads",
      details: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
};
