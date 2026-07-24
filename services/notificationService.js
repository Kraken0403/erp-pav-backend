const db = require('../config/db');

let cachedNotificationSchema = null;

const appendSourceIdToRedirectUrl = (redirectUrl, sourceId) => {
    const normalizedSourceId = toSafeInt(sourceId);
    if (!normalizedSourceId || !redirectUrl) return redirectUrl || null;

    const raw = String(redirectUrl).trim();
    if (!raw) return null;
    if (raw.includes('notification_source_id=')) return raw;

    const joiner = raw.includes('?') ? '&' : '?';
    return `${raw}${joiner}notification_source_id=${normalizedSourceId}`;
};

const getNotificationSchema = async (connection = null, options = {}) => {
    const { forceRefresh = false } = options;
    if (cachedNotificationSchema && !forceRefresh) return cachedNotificationSchema;

    const executor = connection || db;
    const [rows] = await executor.query(
        `
        SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'notifications'
        `
    );

    const columnSet = new Set(rows.map((row) => String(row.COLUMN_NAME || '').toLowerCase()));

    const sourceIdColumn = columnSet.has('source_id')
        ? 'source_id'
        : (columnSet.has('sourceid') ? 'sourceid' : (columnSet.has('sourceId') ? 'sourceId' : null));

    cachedNotificationSchema = {
        hasAction: columnSet.has('action'),
        hasSourceId: Boolean(sourceIdColumn),
        sourceIdColumn,
        hasTitle: columnSet.has('title'),
        hasMessage: columnSet.has('message'),
        hasRedirectUrl: columnSet.has('redirect_url'),
        statusColumn: columnSet.has('is_read') ? 'is_read' : (columnSet.has('is_seen') ? 'is_seen' : null),
    };

    return cachedNotificationSchema;
};

const toSafeInt = (value) => {
    const num = Number(value);
    return Number.isInteger(num) && num > 0 ? num : null;
};

const uniqueInts = (values = []) => {
    const set = new Set();

    for (const value of values) {
        const parsed = toSafeInt(value);
        if (parsed) set.add(parsed);
    }

    return [...set];
};

const createNotification = async ({
    byUserId,
    toUserId,
    module,
    action,
    sourceId = null,
    redirectUrl = null,
    connection = null,
}) => {
    const actorId = toSafeInt(byUserId);
    const receiverId = toSafeInt(toUserId);

    if (!actorId || !receiverId || !module) {
        return null;
    }

    const executor = connection || db;
    const schema = await getNotificationSchema(executor, { forceRefresh: true });
    const normalizedSourceId = toSafeInt(sourceId);
    const normalizedRedirectUrl = schema.hasSourceId
        ? (redirectUrl || null)
        : appendSourceIdToRedirectUrl(redirectUrl, normalizedSourceId);

    const actionColumn = schema.hasAction
        ? 'action'
        : (schema.hasTitle ? 'title' : (schema.hasMessage ? 'message' : null));

    // Keep a single notification row per recipient+module+record by updating the latest one.
    if (schema.hasSourceId && schema.sourceIdColumn && normalizedSourceId) {
        const [existingRows] = await executor.query(
            `
            SELECT id
            FROM notifications
            WHERE to_user_id = ?
                            AND LOWER(CONVERT(COALESCE(module, '') USING utf8mb4) COLLATE utf8mb4_unicode_ci) = LOWER(CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci)
              AND ${schema.sourceIdColumn} = ?
            ORDER BY created_at DESC, id DESC
            `,
            [receiverId, String(module).trim().toLowerCase(), normalizedSourceId]
        );

        if (Array.isArray(existingRows) && existingRows.length) {
            const keepId = toSafeInt(existingRows[0]?.id);

            if (keepId) {
                const updateColumns = ['by_user_id = ?', 'module = ?'];
                const updateParams = [actorId, String(module).trim()];

                if (actionColumn) {
                    updateColumns.push(`${actionColumn} = ?`);
                    updateParams.push(action || null);
                }

                if (schema.hasRedirectUrl) {
                    updateColumns.push('redirect_url = ?');
                    updateParams.push(normalizedRedirectUrl);
                }

                if (schema.statusColumn) {
                    updateColumns.push(`${schema.statusColumn} = 0`);
                }

                // Bump timestamp so latest activity appears first.
                updateColumns.push('created_at = CURRENT_TIMESTAMP');

                await executor.query(
                    `
                    UPDATE notifications
                    SET ${updateColumns.join(', ')}
                    WHERE id = ?
                      AND to_user_id = ?
                    `,
                    [...updateParams, keepId, receiverId]
                );

                // Ensure any duplicate rows for this record are not left unread.
                if (schema.statusColumn && existingRows.length > 1) {
                    const duplicateIds = existingRows
                        .slice(1)
                        .map((row) => toSafeInt(row?.id))
                        .filter(Boolean);

                    if (duplicateIds.length) {
                        const placeholders = duplicateIds.map(() => '?').join(', ');
                        await executor.query(
                            `
                            UPDATE notifications
                            SET ${schema.statusColumn} = 1
                            WHERE to_user_id = ?
                              AND id IN (${placeholders})
                            `,
                            [receiverId, ...duplicateIds]
                        );
                    }
                }

                return keepId;
            }
        }
    }

    const columns = ['by_user_id', 'to_user_id', 'module'];
    const params = [actorId, receiverId, String(module).trim()];

    if (actionColumn) {
        columns.push(actionColumn);
        params.push(action || null);
    }

    if (schema.hasSourceId && schema.sourceIdColumn) {
        columns.push(schema.sourceIdColumn);
        params.push(normalizedSourceId);
    }

    if (schema.hasRedirectUrl) {
        columns.push('redirect_url');
        params.push(normalizedRedirectUrl);
    }

    const placeholders = columns.map(() => '?').join(', ');

    const [result] = await executor.query(
        `
    INSERT INTO notifications
            (${columns.join(', ')})
    VALUES (${placeholders})
    `,
        params
    );

    return result.insertId;
};

const socketService = require('./socketService');

const createNotificationsForUsers = async ({
    byUserId,
    toUserIds = [],
    module,
    action,
    sourceId = null,
    redirectUrl = null,
    connection = null,
    skipSelf = false,
}) => {
    const actorId = toSafeInt(byUserId);
    if (!actorId) return [];

    const recipients = uniqueInts(toUserIds).filter((userId) => {
        if (!skipSelf) return true;
        return userId !== actorId;
    });

    if (!recipients.length) return [];

    // Ensure recipient IDs actually exist (and are not deleted) to avoid FK errors.
    const executor = connection || db;
    try {
        const placeholders = recipients.map(() => '?').join(',');
        const [rows] = await executor.query(
            `
            SELECT id
            FROM users
            WHERE COALESCE(is_deleted, 0) = 0
              AND id IN (${placeholders})
            `,
            recipients
        );

        const existingIds = uniqueInts(rows.map((r) => r.id));

        const missing = recipients.filter((r) => !existingIds.includes(r));
        if (missing.length) {
            const stack = new Error().stack;
            console.warn('notificationService: dropping non-existent recipient ids', {
                actorId,
                recipients,
                missing,
                stack,
            });
        }

        if (!existingIds.length) return [];

        const insertedIds = [];
        for (const recipientId of existingIds) {
            const notificationId = await createNotification({
                byUserId: actorId,
                toUserId: recipientId,
                module,
                action,
                sourceId,
                redirectUrl,
                connection,
            });

            if (notificationId) {
                insertedIds.push(notificationId);

                // Emit notification in real-time to connected clients (if any)
                try {
                    socketService.emitNotification(recipientId, {
                        id: notificationId,
                        byUserId: actorId,
                        module,
                        action,
                        sourceId,
                        redirectUrl,
                        created_at: new Date().toISOString(),
                    });
                } catch (e) {
                    // Log and continue — failure to emit should not block creation
                    console.error('Failed to emit notification via socket:', e && e.message ? e.message : e);
                }
            }
        }

        return insertedIds;
    } catch (e) {
        console.error('createNotificationsForUsers validation error:', e);
        // On validation/query error, avoid creating potentially invalid notifications.
        return [];
    }
};

const getAdminUserIds = async (connection = null) => {
    const executor = connection || db;

    const [rows] = await executor.query(
        `
    SELECT u.id
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
        WHERE LOWER(CONVERT(COALESCE(r.name, u.role, '') USING utf8mb4) COLLATE utf8mb4_unicode_ci) = LOWER(CONVERT('admin' USING utf8mb4) COLLATE utf8mb4_unicode_ci)
      AND COALESCE(u.is_deleted, 0) = 0
    `
    );

    const adminIds = uniqueInts(rows.map((row) => row.id));
    if (adminIds.length) return adminIds;

    // Fallback for environments where role mapping is different or not configured.
    const [allActiveRows] = await executor.query(
        `
    SELECT id
    FROM users
    WHERE COALESCE(is_deleted, 0) = 0
    `
    );

    return uniqueInts(allActiveRows.map((row) => row.id));
};

const resolveUserIdByAssignment = async (value, connection = null) => {
    const directId = toSafeInt(value);
    if (directId) return directId;

    const raw = String(value || '').trim();
    if (!raw) return null;

    const executor = connection || db;

    const [rows] = await executor.query(
        `
        SELECT id
        FROM users
        WHERE COALESCE(is_deleted, 0) = 0
            AND (
                LOWER(CONVERT(name USING utf8mb4) COLLATE utf8mb4_unicode_ci) = LOWER(CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci)
                OR LOWER(CONVERT(email USING utf8mb4) COLLATE utf8mb4_unicode_ci) = LOWER(CONVERT(? USING utf8mb4) COLLATE utf8mb4_unicode_ci)
            )
        LIMIT 1
        `,
        [raw, raw]
    );

    return toSafeInt(rows?.[0]?.id);
};

const getSystemNotifierUserId = async (connection = null) => {
    const admins = await getAdminUserIds(connection);
    if (admins.length) return admins[0];

    const executor = connection || db;
    const [rows] = await executor.query(
        `
    SELECT id
    FROM users
    WHERE COALESCE(is_deleted, 0) = 0
    ORDER BY id ASC
    LIMIT 1
    `
    );

    return toSafeInt(rows?.[0]?.id);
};

module.exports = {
    createNotification,
    createNotificationsForUsers,
    getAdminUserIds,
    resolveUserIdByAssignment,
    getSystemNotifierUserId,
    getNotificationSchema,
};
