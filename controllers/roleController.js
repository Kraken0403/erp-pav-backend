const db = require('../config/db');

const VISIBILITY_MODULE_KEYS = [
  'dashboard',
  'leads',
  'products',
  'quotations',
  'work_orders',
  'kots',
  'deliveries',
  'invoices',
  'settings',
  'reports',
  'users',
];

const getDefaultVisibilityPermissions = () => {
  return VISIBILITY_MODULE_KEYS.reduce((acc, key) => {
    acc[key] = true;
    return acc;
  }, {});
};

const normalizePermissionsForDb = (permissions = {}) => {
  return VISIBILITY_MODULE_KEYS.reduce((acc, key) => {
    const value = Object.prototype.hasOwnProperty.call(permissions, key)
      ? permissions[key]
      : true;
    acc[key] = value ? 1 : 0;
    return acc;
  }, {});
};

const getRoleWithAssignment = async (roleId) => {
  const [roleRows] = await db.query(
    'SELECT id, name, description FROM roles WHERE id = ? LIMIT 1',
    [roleId]
  );

  if (!roleRows.length) {
    return null;
  }

  const role = roleRows[0];

  const [assignedUsers] = await db.query(
    `
    SELECT id, name, email
    FROM users
    WHERE role_id = ?
    ORDER BY name ASC
    LIMIT 100
    `,
    [roleId]
  );

  return {
    role,
    assignedUsers,
    assignedCount: assignedUsers.length,
    canDirectDelete: assignedUsers.length === 0,
    isAdminRole: String(role.name || '').toLowerCase() === 'admin',
  };
};

exports.getAllRoles = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, name, description, created_at, updated_at FROM roles ORDER BY name ASC');
    return res.status(200).json(rows);
  } catch (err) {
    console.error('getAllRoles error:', err);
    return res.status(500).json({ error: 'Failed to fetch roles', details: err.message });
  }
};

exports.getRoleById = async (req, res) => {
  try {
    const roleId = Number(req.params.id);

    if (!Number.isInteger(roleId)) {
      return res.status(400).json({ error: 'Invalid role id' });
    }

    const [rows] = await db.query(
      'SELECT id, name, description, created_at, updated_at FROM roles WHERE id = ? LIMIT 1',
      [roleId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Role not found' });
    }

    return res.status(200).json(rows[0]);
  } catch (err) {
    console.error('getRoleById error:', err);
    return res.status(500).json({ error: 'Failed to fetch role', details: err.message });
  }
};

exports.createRole = async (req, res) => {
  try {
    const { name, description } = req.body || {};

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Role name is required' });
    }

    const roleName = name.trim();
    if (!roleName) {
      return res.status(400).json({ error: 'Role name is required' });
    }

    const [existing] = await db.query(
      'SELECT id FROM roles WHERE LOWER(name) = LOWER(?) LIMIT 1',
      [roleName]
    );

    if (existing.length) {
      return res.status(409).json({ error: 'Role already exists' });
    }

    const [result] = await db.query(
      'INSERT INTO roles (name, description) VALUES (?, ?)',
      [roleName, description || null]
    );

    return res.status(201).json({
      message: 'Role created successfully',
      roleId: result.insertId,
    });
  } catch (err) {
    console.error('createRole error:', err);
    return res.status(500).json({ error: 'Failed to create role', details: err.message });
  }
};

exports.updateRole = async (req, res) => {
  try {
    const roleId = Number(req.params.id);
    const { name, description } = req.body || {};

    if (!Number.isInteger(roleId)) {
      return res.status(400).json({ error: 'Invalid role id' });
    }

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Role name is required' });
    }

    const roleName = name.trim();

    const [duplicate] = await db.query(
      'SELECT id FROM roles WHERE LOWER(name) = LOWER(?) AND id <> ? LIMIT 1',
      [roleName, roleId]
    );

    if (duplicate.length) {
      return res.status(409).json({ error: 'Role name already in use' });
    }

    const [result] = await db.query(
      'UPDATE roles SET name = ?, description = ? WHERE id = ?',
      [roleName, description || null, roleId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Role not found' });
    }

    return res.status(200).json({ message: 'Role updated successfully', roleId });
  } catch (err) {
    console.error('updateRole error:', err);
    return res.status(500).json({ error: 'Failed to update role', details: err.message });
  }
};

exports.deleteRole = async (req, res) => {
  try {
    const roleId = Number(req.params.id);

    if (!Number.isInteger(roleId)) {
      return res.status(400).json({ error: 'Invalid role id' });
    }

    const roleImpact = await getRoleWithAssignment(roleId);
    if (!roleImpact) {
      return res.status(404).json({ message: 'Role not found' });
    }

    if (roleImpact.isAdminRole) {
      return res.status(400).json({ error: 'Admin role cannot be deleted' });
    }

    if (roleImpact.assignedCount > 0) {
      return res.status(409).json({
        error: 'Role is assigned to users. Reassign users before deleting this role.',
        impact: roleImpact,
      });
    }

    const [result] = await db.query('DELETE FROM roles WHERE id = ?', [roleId]);
    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Role not found' });
    }

    return res.status(200).json({ message: 'Role deleted successfully', roleId });
  } catch (err) {
    console.error('deleteRole error:', err);
    return res.status(500).json({ error: 'Failed to delete role', details: err.message });
  }
};

exports.getRoleDeleteImpact = async (req, res) => {
  try {
    const roleId = Number(req.params.id);

    if (!Number.isInteger(roleId)) {
      return res.status(400).json({ error: 'Invalid role id' });
    }

    const roleImpact = await getRoleWithAssignment(roleId);
    if (!roleImpact) {
      return res.status(404).json({ message: 'Role not found' });
    }

    return res.status(200).json(roleImpact);
  } catch (err) {
    console.error('getRoleDeleteImpact error:', err);
    return res.status(500).json({ error: 'Failed to fetch role delete impact', details: err.message });
  }
};

exports.deleteRoleWithReassignment = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const roleId = Number(req.params.id);
    const reassignToRoleId = Number(req.body?.reassignToRoleId);

    if (!Number.isInteger(roleId) || !Number.isInteger(reassignToRoleId)) {
      return res.status(400).json({ error: 'Valid roleId and reassignToRoleId are required' });
    }

    if (roleId === reassignToRoleId) {
      return res.status(400).json({ error: 'Reassignment role must be different' });
    }

    const roleImpact = await getRoleWithAssignment(roleId);
    if (!roleImpact) {
      return res.status(404).json({ message: 'Role not found' });
    }

    if (roleImpact.isAdminRole) {
      return res.status(400).json({ error: 'Admin role cannot be deleted' });
    }

    const [targetRoleRows] = await connection.query(
      'SELECT id, name FROM roles WHERE id = ? LIMIT 1',
      [reassignToRoleId]
    );

    if (!targetRoleRows.length) {
      return res.status(400).json({ error: 'Reassignment role not found' });
    }

    const targetRole = targetRoleRows[0];

    await connection.beginTransaction();

    await connection.query(
      'UPDATE users SET role_id = ? WHERE role_id = ?',
      [targetRole.id, roleId]
    );

    await connection.query('DELETE FROM roles WHERE id = ?', [roleId]);

    await connection.commit();

    return res.status(200).json({
      message: 'Role reassigned and deleted successfully',
      deletedRoleId: roleId,
      reassignedToRoleId: targetRole.id,
      reassignedUsers: roleImpact.assignedCount,
    });
  } catch (err) {
    await connection.rollback();
    console.error('deleteRoleWithReassignment error:', err);
    return res.status(500).json({ error: 'Failed to delete role with reassignment', details: err.message });
  } finally {
    connection.release();
  }
};

exports.getRoleVisibilityPermissions = async (req, res) => {
  try {
    const roleId = Number(req.params.id);

    if (!Number.isInteger(roleId)) {
      return res.status(400).json({ error: 'Invalid role id' });
    }

    const [roleRows] = await db.query('SELECT id FROM roles WHERE id = ? LIMIT 1', [roleId]);
    if (!roleRows.length) {
      return res.status(404).json({ message: 'Role not found' });
    }

    const [rows] = await db.query(
      'SELECT * FROM role_visibility_permissions WHERE role_id = ? LIMIT 1',
      [roleId]
    );

    if (!rows.length) {
      return res.status(200).json({
        roleId,
        permissions: getDefaultVisibilityPermissions(),
        source: 'default'
      });
    }

    const row = rows[0];
    const permissions = VISIBILITY_MODULE_KEYS.reduce((acc, key) => {
      acc[key] = Boolean(row[key]);
      return acc;
    }, {});

    return res.status(200).json({ roleId, permissions, source: 'db' });
  } catch (err) {
    console.error('getRoleVisibilityPermissions error:', err);
    return res.status(500).json({ error: 'Failed to fetch role permissions', details: err.message });
  }
};

exports.upsertRoleVisibilityPermissions = async (req, res) => {
  try {
    const roleId = Number(req.params.id);
    const { permissions } = req.body || {};

    if (!Number.isInteger(roleId)) {
      return res.status(400).json({ error: 'Invalid role id' });
    }

    if (!permissions || typeof permissions !== 'object') {
      return res.status(400).json({ error: 'permissions object is required' });
    }

    const [roleRows] = await db.query('SELECT id FROM roles WHERE id = ? LIMIT 1', [roleId]);
    if (!roleRows.length) {
      return res.status(404).json({ message: 'Role not found' });
    }

    // Fetch global settings to check business_type
    const [settingsRows] = await db.query(
      `SELECT business_type FROM settings WHERE id = 1 LIMIT 1`
    );
    const businessType = settingsRows?.[0]?.business_type || 'GENERAL';
    const isCateringBusiness = businessType === 'CATERING';

    // Normalize permissions with catering enforcement
    const normalized = VISIBILITY_MODULE_KEYS.reduce((acc, key) => {
      let value = Object.prototype.hasOwnProperty.call(permissions, key)
        ? permissions[key]
        : true;

      // Force catering modules to 0 if not CATERING business
      if (['kots', 'deliveries'].includes(key) && !isCateringBusiness) {
        value = 0;
      }

      acc[key] = value ? 1 : 0;
      return acc;
    }, {});

    await db.query(
      `
      INSERT INTO role_visibility_permissions (
        role_id, dashboard, leads, products, quotations, work_orders,
        kots, deliveries, invoices, settings, reports, users
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        dashboard = VALUES(dashboard),
        leads = VALUES(leads),
        products = VALUES(products),
        quotations = VALUES(quotations),
        work_orders = VALUES(work_orders),
        kots = VALUES(kots),
        deliveries = VALUES(deliveries),
        invoices = VALUES(invoices),
        settings = VALUES(settings),
        reports = VALUES(reports),
        users = VALUES(users),
        updated_at = CURRENT_TIMESTAMP
      `,
      [
        roleId,
        normalized.dashboard,
        normalized.leads,
        normalized.products,
        normalized.quotations,
        normalized.work_orders,
        normalized.kots,
        normalized.deliveries,
        normalized.invoices,
        normalized.settings,
        normalized.reports,
        normalized.users,
      ]
    );

    return res.status(200).json({
      message: 'Role permissions saved successfully',
      roleId,
      permissions: VISIBILITY_MODULE_KEYS.reduce((acc, key) => {
        acc[key] = Boolean(normalized[key]);
        return acc;
      }, {})
    });
  } catch (err) {
    console.error('upsertRoleVisibilityPermissions error:', err);
    return res.status(500).json({ error: 'Failed to save role permissions', details: err.message });
  }
};
