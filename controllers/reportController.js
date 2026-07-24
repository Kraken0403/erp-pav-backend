const db = require('../config/db');
const { generateReportPdf } = require('../services/reportPdfService');

const sendPdfResponse = (res, pdfBuffer, fileName) => {
  const buffer = Buffer.from(pdfBuffer || []);

  if (!buffer.length) {
    throw new Error('PDF generation returned empty buffer');
  }

  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': buffer.length,
    'Content-Disposition': `attachment; filename=${fileName}`,
  });

  res.end(buffer);
};

const toDateOnlyString = (value = new Date()) => {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Get Sales Report
 * Query invoices/quotations within date range
 */
exports.getSalesReport = async (req, res) => {
  try {
    const { startDate, endDate, reportType } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start date and end date are required' });
    }

    let query = '';
    let params = [startDate, endDate];

    if (reportType === 'invoices') {
      query = `
        SELECT 
          i.id,
          i.invoice_number,
          i.issue_date as date,
          JSON_UNQUOTE(JSON_EXTRACT(i.billing_snapshot, '$.name')) as customer_name,
          i.grand_total as total_amount,
          i.status,
          i.source_type
        FROM invoices i
        WHERE i.issue_date BETWEEN ? AND ?
        ORDER BY i.issue_date DESC
      `;
    } else if (reportType === 'quotations') {
      query = `
        SELECT 
          q.id,
          q.quotation_number,
          q.quotation_date as date,
          COALESCE(l.first_name, 'Unknown') as customer_name,
          q.total_amount,
          q.status
        FROM quotations q
        LEFT JOIN leads l ON q.lead_id = l.id
        WHERE q.quotation_date BETWEEN ? AND ?
        ORDER BY q.quotation_date DESC
      `;
    } else {
      // Combined sales report
      query = `
        SELECT 
          'Invoice' as type,
          i.invoice_number as number,
          i.issue_date as date,
          JSON_UNQUOTE(JSON_EXTRACT(i.billing_snapshot, '$.name')) as customer_name,
          i.grand_total as total_amount,
          i.status,
          i.source_type
        FROM invoices i
        WHERE i.issue_date BETWEEN ? AND ?
        
        UNION ALL
        
        SELECT 
          'Quotation' as type,
          q.quotation_number as number,
          q.quotation_date as date,
          COALESCE(l.first_name, 'Unknown') as customer_name,
          q.total_amount,
          q.status,
          NULL
        FROM quotations q
        LEFT JOIN leads l ON q.lead_id = l.id
        WHERE q.quotation_date BETWEEN ? AND ?
        
        ORDER BY date DESC
      `;
      params = [startDate, endDate, startDate, endDate];
    }

    const [results] = await db.query(query, params);

    // Calculate summary
    const totalRevenue = results.reduce((sum, item) => {
      return sum + (parseFloat(item.total_amount) || 0);
    }, 0);

    const summary = {
      totalRecords: results.length,
      totalRevenue: totalRevenue,
      startDate,
      endDate,
      reportType: reportType || 'combined'
    };

    res.json({ data: results, summary });
  } catch (error) {
    console.error('Error generating sales report:', error);
    res.status(500).json({ error: 'Failed to generate sales report' });
  }
};

/**
 * Get Customer Report
 * List customers with their transaction summary
 */
exports.getCustomerReport = async (req, res) => {
  try {
    const { startDate, endDate, sourceType } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start date and end date are required' });
    }

    // Build query dynamically to optionally filter by invoice source_type
    let query = `
      SELECT 
        JSON_UNQUOTE(JSON_EXTRACT(i.billing_snapshot, '$.name')) as customer_name,
        JSON_UNQUOTE(JSON_EXTRACT(i.billing_snapshot, '$.email')) as customer_email,
        JSON_UNQUOTE(JSON_EXTRACT(i.billing_snapshot, '$.phone')) as customer_phone,
        COUNT(i.id) as total_invoices,
        SUM(i.grand_total) as total_spent,
        MAX(i.issue_date) as last_transaction_date,
        SUM(CASE WHEN i.status = 'paid' THEN i.grand_total ELSE 0 END) as paid_amount,
        SUM(CASE WHEN i.status != 'paid' THEN i.grand_total ELSE 0 END) as pending_amount
      FROM invoices i
      WHERE i.issue_date BETWEEN ? AND ?
    `;

    const params = [startDate, endDate];

    if (sourceType) {
      query += ` AND i.source_type = ? `;
      params.push(sourceType);
    }

    query += `\n      GROUP BY JSON_UNQUOTE(JSON_EXTRACT(i.billing_snapshot, '$.name')), JSON_UNQUOTE(JSON_EXTRACT(i.billing_snapshot, '$.email')), JSON_UNQUOTE(JSON_EXTRACT(i.billing_snapshot, '$.phone'))\n      ORDER BY total_spent DESC\n    `;

    const [results] = await db.query(query, params);

    const summary = {
      totalCustomers: results.length,
      totalRevenue: results.reduce((sum, c) => sum + parseFloat(c.total_spent || 0), 0),
      startDate,
      endDate
    };

    res.json({ data: results, summary });
  } catch (error) {
    console.error('Error generating customer report:', error);
    res.status(500).json({ error: 'Failed to generate customer report' });
  }
};

/**
 * Get Product Report
 * Show product sales/inventory
 */
exports.getProductReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start date and end date are required' });
    }

    // Get product sales from invoice items
    const query = `
      SELECT 
        COALESCE(NULLIF(ii.description, ''), p.name, 'Unknown Item') as product_name,
        SUM(ii.quantity) as total_quantity_sold,
        SUM(ii.line_total) as total_revenue,
        COUNT(DISTINCT ii.invoice_id) as times_ordered,
        AVG(ii.unit_price) as avg_price
      FROM invoice_items ii
      INNER JOIN invoices i ON ii.invoice_id = i.id
      LEFT JOIN products p ON p.id = ii.product_id
      WHERE i.issue_date BETWEEN ? AND ?
      GROUP BY COALESCE(NULLIF(ii.description, ''), p.name, 'Unknown Item')
      ORDER BY total_revenue DESC
    `;

    const [results] = await db.query(query, [startDate, endDate]);

    const summary = {
      totalProducts: results.length,
      totalRevenue: results.reduce((sum, p) => sum + parseFloat(p.total_revenue || 0), 0),
      totalQuantitySold: results.reduce((sum, p) => sum + parseInt(p.total_quantity_sold || 0), 0),
      startDate,
      endDate
    };

    res.json({ data: results, summary });
  } catch (error) {
    console.error('Error generating product report:', error);
    res.status(500).json({ error: 'Failed to generate product report' });
  }
};

/**
 * Get Lead Report
 * Show lead conversion and status
 */
exports.getLeadReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start date and end date are required' });
    }

    // Get leads created in the date range
    const query = `
      SELECT 
        l.lead_status as status,
        COALESCE(NULLIF(l.source, ''), 'Unknown') as source,
        COUNT(*) as count,
        SUM(CASE WHEN q.lead_id IS NOT NULL THEN 1 ELSE 0 END) as converted_count,
        CONCAT(
          ROUND(
            (SUM(CASE WHEN q.lead_id IS NOT NULL THEN 1 ELSE 0 END) * 100.0) / NULLIF(COUNT(*), 0),
            2
          ),
          '%'
        ) as conversion_rate,
        GROUP_CONCAT(DISTINCT COALESCE(u.name, l.assigned_salesperson) SEPARATOR ', ') as assigned_users
      FROM leads l
      LEFT JOIN (
        SELECT DISTINCT lead_id
        FROM quotations
        WHERE lead_id IS NOT NULL
      ) q ON q.lead_id = l.id
      LEFT JOIN users u ON CAST(u.id AS CHAR) = CAST(l.assigned_salesperson AS CHAR)
      WHERE DATE(l.created_at) BETWEEN ? AND ?
      GROUP BY l.lead_status, COALESCE(NULLIF(l.source, ''), 'Unknown')
      ORDER BY count DESC, l.lead_status ASC
    `;

    const [results] = await db.query(query, [startDate, endDate]);

    // Get total leads
    const [totalLeads] = await db.query(
      'SELECT COUNT(*) as total FROM leads WHERE created_at BETWEEN ? AND ?',
      [startDate, endDate]
    );

    // Get converted leads (those with quotations)
    const [convertedLeads] = await db.query(`
      SELECT COUNT(DISTINCT l.id) as converted
      FROM leads l
      INNER JOIN quotations q ON q.lead_id = l.id
      WHERE l.created_at BETWEEN ? AND ?
    `, [startDate, endDate]);

    const topSourceRow = results.reduce((best, row) => {
      if (!best || Number(row.count || 0) > Number(best.count || 0)) return row;
      return best;
    }, null);

    const topStatusRow = results.reduce((best, row) => {
      if (!best || Number(row.count || 0) > Number(best.count || 0)) return row;
      return best;
    }, null);

    const summary = {
      totalLeads: totalLeads[0].total,
      convertedLeads: convertedLeads[0].converted,
      conversionRate: totalLeads[0].total > 0
        ? ((convertedLeads[0].converted / totalLeads[0].total) * 100).toFixed(2) + '%'
        : '0%',
      topSource: topSourceRow?.source || 'N/A',
      topStatus: topStatusRow?.status || 'N/A',
      startDate,
      endDate
    };

    res.json({ data: results, summary });
  } catch (error) {
    console.error('Error generating lead report:', error);
    res.status(500).json({ error: 'Failed to generate lead report' });
  }
};

/**
 * Get Work Order Report (for CATERING businesses)
 */
exports.getWorkOrderReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Start date and end date are required' });
    }

    const query = `
      SELECT 
        wo.id,
        wo.work_order_number,
        wo.issue_date as work_order_date,
        wo.customer_name,
        wo.total_amount,
        wo.status,
        wo.mode,
        wo.event_date,
        wo.event_time,
        wo.event_location as venue
      FROM work_orders wo
      WHERE DATE(wo.issue_date) BETWEEN ? AND ?
      ORDER BY wo.issue_date DESC
    `;

    const [results] = await db.query(query, [startDate, endDate]);

    const summary = {
      totalWorkOrders: results.length,
      totalRevenue: results.reduce((sum, wo) => sum + parseFloat(wo.total_amount || 0), 0),
      cateringOrders: results.filter(wo => wo.mode === 'CATERING').length,
      generalOrders: results.filter(wo => wo.mode === 'GENERAL').length,
      startDate,
      endDate
    };

    res.json({ data: results, summary });
  } catch (error) {
    console.error('Error generating work order report:', error);
    res.status(500).json({ error: 'Failed to generate work order report' });
  }
};

/**
 * Export Sales Report as PDF
 */
exports.exportSalesPdf = async (req, res) => {
  try {
    const { startDate, endDate, reportType } = req.query;

    // Get report data first
    const reportResult = await new Promise((resolve, reject) => {
      const mockReq = { query: { startDate, endDate, reportType } };
      const mockRes = {
        json: (data) => resolve(data),
        status: () => ({ json: (err) => reject(err) })
      };
      exports.getSalesReport(mockReq, mockRes);
    });

    // Generate PDF
    const pdfBuffer = await generateReportPdf('sales', reportResult.data, reportResult.summary);
    sendPdfResponse(
      res,
      pdfBuffer,
      `sales-report-${toDateOnlyString()}.pdf`
    );
  } catch (error) {
    console.error('Error exporting sales PDF:', error);
    res.status(500).json({ error: 'Failed to export PDF' });
  }
};

/**
 * Export Customer Report as PDF
 */
exports.exportCustomersPdf = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Get report data first
    const reportResult = await new Promise((resolve, reject) => {
      const mockReq = { query: { startDate, endDate } };
      const mockRes = {
        json: (data) => resolve(data),
        status: () => ({ json: (err) => reject(err) })
      };
      exports.getCustomerReport(mockReq, mockRes);
    });

    // Generate PDF
    const pdfBuffer = await generateReportPdf('customers', reportResult.data, reportResult.summary);
    sendPdfResponse(
      res,
      pdfBuffer,
      `customer-report-${toDateOnlyString()}.pdf`
    );
  } catch (error) {
    console.error('Error exporting customer PDF:', error);
    res.status(500).json({ error: 'Failed to export PDF' });
  }
};

/**
 * Export Product Report as PDF
 */
exports.exportProductsPdf = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Get report data first
    const reportResult = await new Promise((resolve, reject) => {
      const mockReq = { query: { startDate, endDate } };
      const mockRes = {
        json: (data) => resolve(data),
        status: () => ({ json: (err) => reject(err) })
      };
      exports.getProductReport(mockReq, mockRes);
    });

    // Generate PDF
    const pdfBuffer = await generateReportPdf('products', reportResult.data, reportResult.summary);
    sendPdfResponse(
      res,
      pdfBuffer,
      `product-report-${toDateOnlyString()}.pdf`
    );
  } catch (error) {
    console.error('Error exporting product PDF:', error);
    res.status(500).json({ error: 'Failed to export PDF' });
  }
};

/**
 * Export Lead Report as PDF
 */
exports.exportLeadsPdf = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Get report data first
    const reportResult = await new Promise((resolve, reject) => {
      const mockReq = { query: { startDate, endDate } };
      const mockRes = {
        json: (data) => resolve(data),
        status: () => ({ json: (err) => reject(err) })
      };
      exports.getLeadReport(mockReq, mockRes);
    });

    const pdfBuffer = await generateReportPdf('leads', reportResult.data, reportResult.summary);
    sendPdfResponse(
      res,
      pdfBuffer,
      `lead-report-${toDateOnlyString()}.pdf`
    );
  } catch (error) {
    console.error('Error exporting lead PDF:', error);
    res.status(500).json({ error: 'Failed to export PDF' });
  }
};

/**
 * Export Work Order Report as PDF
 */
exports.exportWorkOrdersPdf = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Get report data first
    const reportResult = await new Promise((resolve, reject) => {
      const mockReq = { query: { startDate, endDate } };
      const mockRes = {
        json: (data) => resolve(data),
        status: () => ({ json: (err) => reject(err) })
      };
      exports.getWorkOrderReport(mockReq, mockRes);
    });

    const pdfBuffer = await generateReportPdf('work-orders', reportResult.data, reportResult.summary);
    sendPdfResponse(
      res,
      pdfBuffer,
      `workorder-report-${toDateOnlyString()}.pdf`
    );
  } catch (error) {
    console.error('Error exporting work order PDF:', error);
    res.status(500).json({ error: 'Failed to export PDF' });
  }
};

/**
 * Get Dashboard / Monthly Aggregated Data
 * Query params:
 * - month: YYYY-MM (target month), defaults to current month
 * - months: number of months to include in trend (including target month), default 6
 */
exports.getDashboardReport = async (req, res) => {
  try {
    const { month, months: monthsParam } = req.query;
    const months = Math.max(1, parseInt(monthsParam || '6', 10));

    // Determine target month (YYYY-MM)
    const now = month ? new Date(`${month}-01`) : new Date();
    if (Number.isNaN(now.getTime())) {
      return res.status(400).json({ error: 'Invalid month parameter' });
    }

    // Compute date range: from first day of (target - months + 1) to last day of target month
    const targetYear = now.getFullYear();
    const targetMonth = now.getMonth();

    const startMonthDate = new Date(targetYear, targetMonth - (months - 1), 1);
    const startDate = `${startMonthDate.getFullYear()}-${String(startMonthDate.getMonth() + 1).padStart(2, '0')}-01`;

    const endMonthDate = new Date(targetYear, targetMonth + 1, 0); // last day of target month
    const endDate = `${endMonthDate.getFullYear()}-${String(endMonthDate.getMonth() + 1).padStart(2, '0')}-${String(endMonthDate.getDate()).padStart(2, '0')}`;

    // Trend by month
    const trendQuery = `
      SELECT DATE_FORMAT(i.issue_date, '%Y-%m') as month,
             COUNT(*) as invoices_count,
             SUM(COALESCE(i.grand_total, 0)) as total_revenue,
             SUM(COALESCE(i.cgst_total,0) + COALESCE(i.sgst_total,0) + COALESCE(i.igst_total,0)) as total_tax
      FROM invoices i
      WHERE i.issue_date BETWEEN ? AND ?
      GROUP BY month
      ORDER BY month ASC
    `;

    const [trendRows] = await db.query(trendQuery, [startDate, endDate]);

    // Summary for target month
    const targetStart = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-01`;
    const targetEndDate = new Date(targetYear, targetMonth + 1, 0);
    const targetEnd = `${targetEndDate.getFullYear()}-${String(targetEndDate.getMonth() + 1).padStart(2, '0')}-${String(targetEndDate.getDate()).padStart(2, '0')}`;

    const summaryQuery = `
      SELECT
        COUNT(*) as invoices_count,
        SUM(COALESCE(grand_total,0)) as total_revenue,
        SUM(COALESCE(cgst_total,0) + COALESCE(sgst_total,0) + COALESCE(igst_total,0)) as total_tax
      FROM invoices
      WHERE issue_date BETWEEN ? AND ?
    `;
    const [summaryRows] = await db.query(summaryQuery, [targetStart, targetEnd]);
    const summary = summaryRows[0] || { invoices_count: 0, total_revenue: 0, total_tax: 0 };

    // Leads count and qualified leads in target month
    const [leadsRows] = await db.query(
      `SELECT COUNT(*) as leads_count, SUM(CASE WHEN LOWER(lead_status) = 'qualified' THEN 1 ELSE 0 END) as qualified_count
       FROM leads
       WHERE DATE(created_at) BETWEEN ? AND ?`,
      [targetStart, targetEnd]
    );
    const leadsCount = Number(leadsRows?.[0]?.leads_count || 0);
    const qualifiedLeads = Number(leadsRows?.[0]?.qualified_count || 0);

    // Quotations count and converted leads (quotations created in month)
    const [quotRows] = await db.query(
      `SELECT COUNT(*) as quotations_count, COUNT(DISTINCT lead_id) as converted_leads
       FROM quotations
       WHERE quotation_date BETWEEN ? AND ?`,
      [targetStart, targetEnd]
    );
    const quotationsCount = Number(quotRows?.[0]?.quotations_count || 0);
    const convertedLeadsFromQuot = Number(quotRows?.[0]?.converted_leads || 0);

    // Work orders and pending invoices count
    const [woRows] = await db.query(
      `SELECT COUNT(*) as work_orders_count
       FROM work_orders
       WHERE DATE(issue_date) BETWEEN ? AND ?`,
      [targetStart, targetEnd]
    );
    const workOrdersCount = Number(woRows?.[0]?.work_orders_count || 0);

    // Products count
    const [prodRows] = await db.query(`SELECT COUNT(*) as products_count FROM products`);
    const productsCount = Number(prodRows?.[0]?.products_count || 0);

    // Pending KOTs (status = 'pending') in target month
    const [kotRows] = await db.query(
      `SELECT COUNT(*) as pending_kots
       FROM kots
       WHERE DATE(generated_at) BETWEEN ? AND ?
         AND status = 'pending'`,
      [targetStart, targetEnd]
    );
    const pendingKots = Number(kotRows?.[0]?.pending_kots || 0);

    // Collection rate: sum(payments) / sum(invoices) for target month
    const [paymentsRows] = await db.query(
      `SELECT COALESCE(SUM(p.amount),0) as collected
       FROM payments p
       INNER JOIN invoices i ON p.invoice_id = i.id
       WHERE i.issue_date BETWEEN ? AND ?`,
      [targetStart, targetEnd]
    );
    const collected = Number(paymentsRows?.[0]?.collected || 0);
    const invoiced = Number(summary.total_revenue || 0);
    const collectionRate = invoiced > 0 ? (collected / invoiced) * 100 : 0;

    // Top products for the range (limit 6)
    const topProductsQuery = `
      SELECT COALESCE(NULLIF(ii.description, ''), p.name, 'Unknown Item') as product_name,
             SUM(ii.quantity) as total_quantity_sold,
             SUM(ii.line_total) as total_revenue
      FROM invoice_items ii
      INNER JOIN invoices i ON ii.invoice_id = i.id
      LEFT JOIN products p ON p.id = ii.product_id
      WHERE i.issue_date BETWEEN ? AND ?
      GROUP BY COALESCE(NULLIF(ii.description, ''), p.name, 'Unknown Item')
      ORDER BY total_revenue DESC
      LIMIT 6
    `;
    const [topProducts] = await db.query(topProductsQuery, [startDate, endDate]);

    // Pending invoices count for the range
    const pendingQuery = `
      SELECT i.id,
             i.invoice_number,
             i.issue_date,
             JSON_UNQUOTE(JSON_EXTRACT(i.billing_snapshot, '$.name')) as customer_name,
             i.grand_total,
             COALESCE(p.paid_amount, 0) as paid_amount,
             (COALESCE(i.grand_total,0) - COALESCE(p.paid_amount,0)) as pending_amount,
             CASE WHEN i.due_date IS NOT NULL
                       AND DATE(i.due_date) < CURDATE()
                       AND (COALESCE(i.grand_total,0) - COALESCE(p.paid_amount,0)) > 0
                  THEN 1 ELSE 0 END as is_overdue
      FROM invoices i
      LEFT JOIN (
        SELECT invoice_id, SUM(amount) as paid_amount
        FROM payments
        GROUP BY invoice_id
      ) p ON p.invoice_id = i.id
      WHERE i.issue_date BETWEEN ? AND ?
        AND i.status = 'issued'
        AND COALESCE(i.grand_total, 0) > COALESCE(p.paid_amount, 0)
      ORDER BY i.issue_date DESC
      LIMIT 20
    `;
    // Use target month range for pending invoices (not the full trend range)
    const [pendingInvoices] = await db.query(pendingQuery, [targetStart, targetEnd]);

    res.json({
      data: {
        top_products: topProducts,
        pending_invoices: pendingInvoices
      },
      summary: {
        invoicesCount: Number(summary.invoices_count || 0),
        totalRevenue: Number(summary.total_revenue || 0),
        totalTax: Number(summary.total_tax || 0),
        startDate: targetStart,
        endDate: targetEnd,
        leadsCount,
        qualifiedLeads,
        quotationsCount,
        convertedLeads: convertedLeadsFromQuot,
        workOrdersCount,
        pendingInvoicesCount: pendingInvoices.length,
        productsCount,
        pendingKots,
        totalInvoiceAmount: Number(summary.total_revenue || 0),
        collectionRate: Number(collectionRate.toFixed(2))
      },
      trend: trendRows
    });
  } catch (error) {
    console.error('Error generating dashboard report:', error);
    res.status(500).json({ error: 'Failed to generate dashboard report' });
  }
};

/**
 * Get Customer Detail
 * Query params:
 * - email (preferred) OR name OR phone
 * - limit (optional)
 */
exports.getCustomerDetail = async (req, res) => {
  try {
    const { email, name, phone, limit } = req.query;

    if (!email && !name && !phone) {
      return res.status(400).json({ error: 'Provide email, name or phone to fetch customer detail' });
    }

    const q = `
      SELECT
        i.id,
        i.invoice_number,
        i.issue_date,
        i.due_date,
        i.grand_total,
        i.status,
        i.source_type,
        JSON_UNQUOTE(JSON_EXTRACT(i.billing_snapshot, '$.name')) as customer_name,
        JSON_UNQUOTE(JSON_EXTRACT(i.billing_snapshot, '$.email')) as customer_email,
        JSON_UNQUOTE(JSON_EXTRACT(i.billing_snapshot, '$.phone')) as customer_phone,
        i.billing_snapshot
      FROM invoices i
      WHERE (
        JSON_UNQUOTE(JSON_EXTRACT(i.billing_snapshot, '$.email')) = ?
        OR JSON_UNQUOTE(JSON_EXTRACT(i.billing_snapshot, '$.phone')) = ?
        OR JSON_UNQUOTE(JSON_EXTRACT(i.billing_snapshot, '$.name')) = ?
      )
      ORDER BY i.issue_date DESC
      LIMIT ?
    `;

    const max = Math.min(Number(limit) || 200, 1000);
    const vals = [email || '', phone || '', name || '', max];

    const [rows] = await db.query(q, vals);

    // Basic summary
    const summary = {
      totalInvoices: rows.length,
      totalSpent: rows.reduce((s, r) => s + (parseFloat(r.grand_total) || 0), 0),
      lastTransaction: rows.length ? rows[0].issue_date : null,
    };

    res.json({ data: rows, summary });
  } catch (err) {
    console.error('Error fetching customer detail:', err);
    res.status(500).json({ error: 'Failed to fetch customer detail' });
  }
};

