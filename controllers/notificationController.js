const db = require('../config/db');
const { getNotificationSchema } = require('../services/notificationService');

const toSafeInt = (value) => {
    const num = Number(value);
    return Number.isInteger(num) && num > 0 ? num : null;
};

const inferSourceIdFromRedirect = (redirectUrl = '', moduleName = '') => {
    const raw = String(redirectUrl || '').trim();
    if (!raw) return null;

    const queryMatch = raw.match(/[?&]notification_source_id=(\d+)/i);
    if (queryMatch) {
        const parsed = toSafeInt(queryMatch[1]);
        if (parsed) return parsed;
    }

    if (String(moduleName || '').toLowerCase() === 'leads') {
        const leadMatch = raw.match(/\/leads\/(\d+)(?:\/|$)/i);
        return toSafeInt(leadMatch?.[1]);
    }

    if (String(moduleName || '').toLowerCase() === 'work_orders') {
        const workOrderMatch = raw.match(/\/workorders\/(\d+)(?:\/|$)/i);
        return toSafeInt(workOrderMatch?.[1]);
    }

    if (String(moduleName || '').toLowerCase() === 'kot') {
        const kotMatch = raw.match(/\/kots\/(\d+)(?:\/|$)/i);
        return toSafeInt(kotMatch?.[1]);
    }

    if (String(moduleName || '').toLowerCase() === 'delivery') {
        const deliveryMatch = raw.match(/\/deliver(?:y|ies)\/(\d+)(?:\/|$)/i);
        return toSafeInt(deliveryMatch?.[1]);
    }

    return null;
};

const getMyNotifications = async (req, res) => {
    const userId = Number(req.user?.id);

    if (!Number.isInteger(userId)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const schema = await getNotificationSchema(null, { forceRefresh: true });
        const statusExpr = schema.statusColumn ? `n.${schema.statusColumn}` : '0';
        const actionExpr = schema.hasAction
            ? 'n.action'
            : (schema.hasTitle ? 'n.title' : (schema.hasMessage ? 'n.message' : 'NULL'));
        const sourceExpr = schema.hasSourceId && schema.sourceIdColumn ? `n.${schema.sourceIdColumn}` : 'NULL';

        const [summaryRows] = await db.query(
            `
      SELECT
        COUNT(*) AS count,
        SUM(CASE WHEN ${statusExpr} = 1 THEN 1 ELSE 0 END) AS seenNotifications,
        SUM(CASE WHEN ${statusExpr} = 0 THEN 1 ELSE 0 END) AS unSeenNotifications
      FROM notifications n
      WHERE n.to_user_id = ?
      `,
            [userId]
        );

        const summary = summaryRows?.[0] || {};

        const [rows] = await db.query(
            `
      SELECT
        n.id,
        n.module,
                ${actionExpr} AS action,
                ${sourceExpr} AS source_id,
        n.redirect_url,
                ${statusExpr} AS isSeen,
        n.created_at,
        bu.id AS by_user_id,
        bu.name AS by_user_name,
        tu.id AS to_user_id,
        tu.name AS to_user_name
      FROM notifications n
      LEFT JOIN users bu ON bu.id = n.by_user_id
      LEFT JOIN users tu ON tu.id = n.to_user_id
      WHERE n.to_user_id = ?
      ORDER BY n.created_at DESC
      LIMIT 50
      `,
            [userId]
        );

        return res.status(200).json({
            count: Number(summary.count || 0),
            seenNotifications: Number(summary.seenNotifications || 0),
            unSeenNotifications: Number(summary.unSeenNotifications || 0),
            result: rows.map((row) => {
                const normalizedSourceId = toSafeInt(row.source_id) || inferSourceIdFromRedirect(row.redirect_url, row.module);

                return {
                    id: row.id,
                    module: row.module,
                    action: row.action,
                    source_id: normalizedSourceId,
                    redirect_url: row.redirect_url,
                    isSeen: Boolean(row.isSeen),
                    created_at: row.created_at,
                    byUser: {
                        id: row.by_user_id,
                        name: row.by_user_name,
                    },
                    toUser: {
                        id: row.to_user_id,
                        name: row.to_user_name,
                    },
                };
            }),
        });
    } catch (error) {
        console.error('getMyNotifications error:', error);
        return res.status(500).json({ error: error.message });
    }
};

const getBubbleCounts = async (req, res) => {
    const userId = Number(req.user?.id);

    if (!Number.isInteger(userId)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const schema = await getNotificationSchema(null, { forceRefresh: true });
        const statusExpr = schema.statusColumn ? `n.${schema.statusColumn}` : '0';

        const [summaryRows] = await db.query(
            `
      SELECT
        COUNT(*) AS count,
                SUM(CASE WHEN ${statusExpr} = 1 THEN 1 ELSE 0 END) AS seenNotifications,
                SUM(CASE WHEN ${statusExpr} = 0 THEN 1 ELSE 0 END) AS unSeenNotifications
      FROM notifications n
      WHERE n.to_user_id = ?
      `,
            [userId]
        );

        const [moduleRows] = await db.query(
            `
      SELECT n.module, COUNT(*) AS count
      FROM notifications n
      WHERE n.to_user_id = ?
                AND ${statusExpr} = 0
      GROUP BY n.module
      `,
            [userId]
        );

        const moduleCountMap = moduleRows.reduce((acc, row) => {
            acc[row.module] = Number(row.count || 0);
            return acc;
        }, {});

        const summary = summaryRows?.[0] || {};

        return res.status(200).json({
            count: Number(summary.count || 0),
            seenNotifications: Number(summary.seenNotifications || 0),
            unSeenNotifications: Number(summary.unSeenNotifications || 0),
            leadsCount: moduleCountMap.leads || 0,
            workOrderCount: moduleCountMap.work_orders || 0,
            kotCount: moduleCountMap.kot || 0,
            deliveryCount: moduleCountMap.delivery || 0,
            feedbackCount: moduleCountMap.feedback || 0,
        });
    } catch (error) {
        console.error('getBubbleCounts error:', error);
        return res.status(500).json({ error: error.message });
    }
};

const markNotificationSeen = async (req, res) => {
    const userId = Number(req.user?.id);
    const notificationId = Number(req.params.id);

    if (!Number.isInteger(userId)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!Number.isInteger(notificationId)) {
        return res.status(400).json({ error: 'Invalid notification id' });
    }

    try {
        const schema = await getNotificationSchema(null, { forceRefresh: true });

        if (!schema.statusColumn) {
            return res.status(400).json({ error: 'Notifications table is missing read-status column (is_read/is_seen).' });
        }

        const [result] = await db.query(
            `
      UPDATE notifications
        SET ${schema.statusColumn} = 1
      WHERE id = ?
        AND to_user_id = ?
      `,
            [notificationId, userId]
        );

        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Notification not found' });
        }

        return res.status(200).json({ message: 'Notification marked as seen' });
    } catch (error) {
        console.error('markNotificationSeen error:', error);
        return res.status(500).json({ error: error.message });
    }
};

const markAllNotificationsSeen = async (req, res) => {
    const userId = Number(req.user?.id);

    if (!Number.isInteger(userId)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const schema = await getNotificationSchema(null, { forceRefresh: true });

        if (!schema.statusColumn) {
            return res.status(400).json({ error: 'Notifications table is missing read-status column (is_read/is_seen).' });
        }

        const [result] = await db.query(
            `
      UPDATE notifications
        SET ${schema.statusColumn} = 1
      WHERE to_user_id = ?
        AND ${schema.statusColumn} = 0
      `,
            [userId]
        );

        return res.status(200).json({
            message: 'All notifications marked as seen',
            updatedCount: Number(result?.affectedRows || 0),
        });
    } catch (error) {
        console.error('markAllNotificationsSeen error:', error);
        return res.status(500).json({ error: error.message });
    }
};

const markModuleNotificationsSeen = async (req, res) => {
    const userId = Number(req.user?.id);
    const moduleName = String(req.params.module || '').trim().toLowerCase();

    if (!Number.isInteger(userId)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!moduleName) {
        return res.status(400).json({ error: 'Invalid module' });
    }

    try {
        const schema = await getNotificationSchema(null, { forceRefresh: true });

        if (!schema.statusColumn) {
            return res.status(400).json({ error: 'Notifications table is missing read-status column (is_read/is_seen).' });
        }

        const [result] = await db.query(
            `
      UPDATE notifications
        SET ${schema.statusColumn} = 1
      WHERE to_user_id = ?
        AND LOWER(COALESCE(module, '')) = ?
        AND ${schema.statusColumn} = 0
      `,
            [userId, moduleName]
        );

        return res.status(200).json({
            message: 'Module notifications marked as seen',
            module: moduleName,
            updatedCount: Number(result?.affectedRows || 0),
        });
    } catch (error) {
        console.error('markModuleNotificationsSeen error:', error);
        return res.status(500).json({ error: error.message });
    }
};

const markRecordNotificationsSeen = async (req, res) => {
    const userId = Number(req.user?.id);
    const moduleName = String(req.params.module || '').trim().toLowerCase();
    const sourceId = toSafeInt(req.params.sourceId);

    if (!Number.isInteger(userId)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!moduleName || !sourceId) {
        return res.status(400).json({ error: 'Invalid module or source id' });
    }

    try {
        const schema = await getNotificationSchema(null, { forceRefresh: true });

        if (!schema.statusColumn) {
            return res.status(400).json({ error: 'Notifications table is missing read-status column (is_read/is_seen).' });
        }

        if (!schema.hasSourceId || !schema.sourceIdColumn) {
            return res.status(400).json({ error: 'Notifications table is missing source id column.' });
        }

        const [result] = await db.query(
            `
            UPDATE notifications
            SET ${schema.statusColumn} = 1
            WHERE to_user_id = ?
              AND LOWER(COALESCE(module, '')) = ?
              AND ${schema.sourceIdColumn} = ?
              AND ${schema.statusColumn} = 0
            `,
            [userId, moduleName, sourceId]
        );

        return res.status(200).json({
            message: 'Record notifications marked as seen',
            module: moduleName,
            sourceId,
            updatedCount: Number(result?.affectedRows || 0),
        });
    } catch (error) {
        console.error('markRecordNotificationsSeen error:', error);
        return res.status(500).json({ error: error.message });
    }
};

module.exports = {
    getMyNotifications,
    getBubbleCounts,
    markNotificationSeen,
    markAllNotificationsSeen,
    markModuleNotificationsSeen,
    markRecordNotificationsSeen,
};
