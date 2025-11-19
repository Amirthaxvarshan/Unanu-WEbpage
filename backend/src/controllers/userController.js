const { createAdminUser, changePassword } = require('../services/auth');
const { pool } = require('../config/database');
const { encryptData, decryptData } = require('../services/encryption');
const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

/**
 * Create new admin user
 */
const createUser = async (req, res) => {
  try {
    const { email, password, role } = req.body;
    const createdBy = req.user.id;

    if (!email || !password || !role) {
      return res.status(400).json({
        success: false,
        message: 'Email, password, and role are required'
      });
    }

    if (!['admin', 'moderator'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Role must be either admin or moderator'
      });
    }

    // Password validation
    if (password.length < 12) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 12 characters long'
      });
    }

    if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/.test(password)) {
      return res.status(400).json({
        success: false,
        message: 'Password must contain uppercase, lowercase, number, and special character'
      });
    }

    const result = await createAdminUser(email, password, role, createdBy);

    if (result.success) {
      logger.info('Admin user created successfully', {
        newUserId: result.user.id,
        email,
        role,
        createdBy
      });

      res.status(201).json({
        success: true,
        user: result.user,
        message: 'Admin user created successfully'
      });

    } else {
      res.status(400).json({
        success: false,
        message: result.message
      });
    }

  } catch (error) {
    logger.error('Create user controller error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create admin user'
    });
  }
};

/**
 * Get all admin users
 */
const getUsers = async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT
          id,
          email_encrypted,
          role,
          last_login,
          failed_login_attempts,
          locked_until,
          is_active,
          created_at,
          updated_at
        FROM admin_users
        ORDER BY created_at DESC
      `);

      const users = result.rows.map(user => ({
        ...user,
        email: decryptData(user.email_encrypted)
      }));

      res.json({
        success: true,
        data: users
      });

    } finally {
      client.release();
    }

  } catch (error) {
    logger.error('Get users controller error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve admin users'
    });
  }
};

/**
 * Change admin password
 */
const changeUserPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { currentPassword, newPassword } = req.body;
    const ipAddress = req.ip;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required'
      });
    }

    // Only allow users to change their own password unless they're admin
    if (req.user.role !== 'admin' && req.user.id !== id) {
      return res.status(403).json({
        success: false,
        message: 'You can only change your own password'
      });
    }

    // Validate new password
    if (newPassword.length < 12) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 12 characters long'
      });
    }

    if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: 'New password must contain uppercase, lowercase, number, and special character'
      });
    }

    const result = await changePassword(id, currentPassword, newPassword, ipAddress);

    if (result.success) {
      logger.info('Password changed successfully', {
        userId: id,
        changedBy: req.user.id,
        ip: ipAddress
      });

      res.json({
        success: true,
        message: result.message
      });

    } else {
      res.status(400).json({
        success: false,
        message: result.message
      });
    }

  } catch (error) {
    logger.error('Change password controller error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to change password'
    });
  }
};

/**
 * Get current user profile
 */
const getProfile = async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT
          id,
          email_encrypted,
          role,
          last_login,
          created_at,
          updated_at
        FROM admin_users
        WHERE id = $1 AND is_active = true
      `, [req.user.id]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      const user = result.rows[0];
      user.email = decryptData(user.email_encrypted);
      delete user.email_encrypted;

      res.json({
        success: true,
        data: user
      });

    } finally {
      client.release();
    }

  } catch (error) {
    logger.error('Get profile controller error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve user profile'
    });
  }
};

/**
 * Update user profile (non-sensitive fields only)
 */
const updateProfile = async (req, res) => {
  try {
    const { email } = req.body;
    const userId = req.user.id;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format'
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if email already exists for another user
      const encryptedEmail = encryptData(email);
      const existingUser = await client.query(
        'SELECT id FROM admin_users WHERE email_encrypted = $1 AND id != $2',
        [encryptedEmail, userId]
      );

      if (existingUser.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Email already exists'
        });
      }

      // Update email
      await client.query(
        'UPDATE admin_users SET email_encrypted = $1, updated_at = NOW() WHERE id = $2',
        [encryptedEmail, userId]
      );

      await client.query('COMMIT');

      logger.info('User profile updated', {
        userId,
        newEmail: email,
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Profile updated successfully'
      });

    } finally {
      client.release();
    }

  } catch (error) {
    logger.error('Update profile controller error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update profile'
    });
  }
};

/**
 * Delete admin user (admin only)
 */
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    // Prevent self-deletion
    if (req.user.id === id) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete your own account'
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get user details before deletion
      const userResult = await client.query(
        'SELECT email_encrypted, role FROM admin_users WHERE id = $1',
        [id]
      );

      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      const user = userResult.rows[0];

      // Don't allow deletion of other admins unless you're also an admin
      if (user.role === 'admin' && req.user.role !== 'admin') {
        await client.query('ROLLBACK');
        return res.status(403).json({
          success: false,
          message: 'Only admins can delete other admin users'
        });
      }

      // Delete user (cascade will handle related records)
      await client.query('DELETE FROM admin_users WHERE id = $1', [id]);

      await client.query('COMMIT');

      const deletedEmail = decryptData(user.email_encrypted);
      logger.info('Admin user deleted', {
        deletedUserId: id,
        deletedEmail,
        deletedRole: user.role,
        deletedBy: req.user.id,
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Admin user deleted successfully'
      });

    } finally {
      client.release();
    }

  } catch (error) {
    logger.error('Delete user controller error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete admin user'
    });
  }
};

module.exports = {
  createUser,
  getUsers,
  changePassword: changeUserPassword,
  getProfile,
  updateProfile,
  deleteUser
};