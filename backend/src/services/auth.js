const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');
const { encryptData, decryptData, encryptEmail } = require('./encryption');
const winston = require('winston');
require('dotenv').config();

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

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '30m';
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 12;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

/**
 * Authentication service for admin users
 */
class AuthService {
  /**
   * Authenticate admin user
   */
  async authenticate(email, password, ipAddress, userAgent) {
    try {
      const client = await pool.connect();
      try {
        // Encrypt email for lookup
        const encryptedEmail = encryptEmail(email);

        // Find admin user
        const result = await client.query(
          `SELECT id, email_encrypted, password_hash, role, failed_login_attempts,
                  locked_until, last_login, is_active
           FROM admin_users
           WHERE email_encrypted = $1`,
          [encryptedEmail]
        );

        if (result.rows.length === 0) {
          logger.warn('Login attempt with non-existent email', { ip: ipAddress, email });
          return { success: false, message: 'Invalid credentials' };
        }

        const user = result.rows[0];

        // Check if account is locked
        if (user.locked_until && user.locked_until > new Date()) {
          logger.warn('Login attempt on locked account', {
            userId: user.id,
            ip: ipAddress,
            lockedUntil: user.locked_until
          });
          return {
            success: false,
            message: 'Account temporarily locked. Please try again later.'
          };
        }

        // Check if account is active
        if (!user.is_active) {
          logger.warn('Login attempt on inactive account', { userId: user.id, ip: ipAddress });
          return { success: false, message: 'Account is disabled' };
        }

        // Verify password
        const passwordValid = await bcrypt.compare(password, user.password_hash);

        if (!passwordValid) {
          await this.handleFailedLogin(client, user.id, ipAddress);
          logger.warn('Invalid password attempt', { userId: user.id, ip: ipAddress });
          return { success: false, message: 'Invalid credentials' };
        }

        // Successful login - reset failed attempts
        if (user.failed_login_attempts > 0) {
          await client.query(
            'UPDATE admin_users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1',
            [user.id]
          );
        }

        // Update last login
        await client.query(
          'UPDATE admin_users SET last_login = NOW() WHERE id = $1',
          [user.id]
        );

        // Create JWT token
        const token = this.generateToken({
          id: user.id,
          role: user.role,
          email: email // Include email for convenience (not encrypted in token)
        });

        // Create session record
        await this.createSession(client, user.id, token, ipAddress, userAgent);

        const decryptedEmail = decryptData(user.email_encrypted);

        logger.info('Admin login successful', {
          userId: user.id,
          role: user.role,
          ip: ipAddress,
          lastLogin: user.last_login
        });

        return {
          success: true,
          token,
          user: {
            id: user.id,
            email: decryptedEmail,
            role: user.role,
            lastLogin: user.last_login
          }
        };

      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Authentication error:', error);
      return { success: false, message: 'Authentication failed' };
    }
  }

  /**
   * Handle failed login attempts
   */
  async handleFailedLogin(client, userId, ipAddress) {
    const result = await client.query(
      'SELECT failed_login_attempts FROM admin_users WHERE id = $1',
      [userId]
    );

    const failedAttempts = result.rows[0].failed_login_attempts + 1;
    const maxAttempts = 5;

    let lockedUntil = null;
    if (failedAttempts >= maxAttempts) {
      lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    }

    await client.query(
      `UPDATE admin_users
       SET failed_login_attempts = $1, locked_until = $2
       WHERE id = $3`,
      [failedAttempts, lockedUntil, userId]
    );

    logger.warn('Failed login attempt recorded', {
      userId,
      ip: ipAddress,
      failedAttempts,
      lockedUntil
    });
  }

  /**
   * Generate JWT token
   */
  generateToken(payload) {
    return jwt.sign(payload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
      issuer: 'unanu-contact-system',
      audience: 'unanu-admin'
    });
  }

  /**
   * Verify JWT token
   */
  verifyToken(token) {
    try {
      return jwt.verify(token, JWT_SECRET, {
        issuer: 'unanu-contact-system',
        audience: 'unanu-admin'
      });
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw new Error('Token has expired');
      } else if (error.name === 'JsonWebTokenError') {
        throw new Error('Invalid token');
      } else {
        throw new Error('Token verification failed');
      }
    }
  }

  /**
   * Create session record
   */
  async createSession(client, userId, token, ipAddress, userAgent) {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
    const tokenHash = bcrypt.hash(token, 10); // Hash token for storage

    await client.query(
      `INSERT INTO session_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, tokenHash, expiresAt, ipAddress, userAgent]
    );
  }

  /**
   * Validate session token
   */
  async validateSession(token, ipAddress) {
    try {
      const decoded = this.verifyToken(token);

      const client = await pool.connect();
      try {
        // Get active sessions for user
        const result = await client.query(
          `SELECT st.id, st.expires_at, st.ip_address, st.is_active, au.role
           FROM session_tokens st
           JOIN admin_users au ON st.user_id = au.id
           WHERE st.user_id = $1 AND st.is_active = true AND st.expires_at > NOW()
           ORDER BY st.created_at DESC`,
          [decoded.id]
        );

        if (result.rows.length === 0) {
          throw new Error('No active session found');
        }

        // Verify token against stored hashes (we can't verify directly due to bcrypt)
        // Instead, we'll check if the session is recent and valid
        const session = result.rows[0];

        // Optional: Check IP address hasn't changed significantly
        if (ipAddress && session.ip_address && session.ip_address !== ipAddress) {
          logger.warn('Session IP address changed', {
            userId: decoded.id,
            originalIP: session.ip_address,
            newIP: ipAddress
          });
          // Could implement additional security measures here
        }

        return {
          valid: true,
          user: {
            id: decoded.id,
            email: decoded.email,
            role: session.role
          },
          sessionId: session.id
        };

      } finally {
        client.release();
      }

    } catch (error) {
      logger.warn('Session validation failed', { error: error.message });
      return { valid: false, message: error.message };
    }
  }

  /**
   * Logout user
   */
  async logout(token) {
    try {
      const decoded = this.verifyToken(token);

      const client = await pool.connect();
      try {
        // Deactivate all sessions for this user (or specific session)
        await client.query(
          'UPDATE session_tokens SET is_active = false WHERE user_id = $1',
          [decoded.id]
        );

        logger.info('User logged out', { userId: decoded.id });

        return { success: true, message: 'Logged out successfully' };

      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Logout error:', error);
      return { success: false, message: 'Logout failed' };
    }
  }

  /**
   * Refresh token
   */
  async refreshToken(token, ipAddress, userAgent) {
    try {
      const decoded = this.verifyToken(token);

      const client = await pool.connect();
      try {
        // Check if user still exists and is active
        const result = await client.query(
          'SELECT id, role, is_active FROM admin_users WHERE id = $1',
          [decoded.id]
        );

        if (result.rows.length === 0 || !result.rows[0].is_active) {
          return { success: false, message: 'User not found or inactive' };
        }

        // Deactivate old session
        await client.query(
          'UPDATE session_tokens SET is_active = false WHERE user_id = $1',
          [decoded.id]
        );

        // Generate new token
        const newToken = this.generateToken({
          id: decoded.id,
          role: result.rows[0].role,
          email: decoded.email
        });

        // Create new session
        await this.createSession(client, decoded.id, newToken, ipAddress, userAgent);

        logger.info('Token refreshed', { userId: decoded.id });

        return {
          success: true,
          token: newToken
        };

      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Token refresh error:', error);
      return { success: false, message: 'Token refresh failed' };
    }
  }

  /**
   * Create new admin user
   */
  async createAdminUser(email, password, role, createdBy) {
    try {
      const client = await pool.connect();
      try {
        // Check if email already exists
        const encryptedEmail = encryptEmail(email);
        const existingUser = await client.query(
          'SELECT id FROM admin_users WHERE email_encrypted = $1',
          [encryptedEmail]
        );

        if (existingUser.rows.length > 0) {
          return { success: false, message: 'Email already exists' };
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

        // Create user
        const result = await client.query(
          `INSERT INTO admin_users (email_encrypted, password_hash, role)
           VALUES ($1, $2, $3)
           RETURNING id, created_at`,
          [encryptedEmail, passwordHash, role]
        );

        // Log creation
        await client.query(
          `INSERT INTO audit_log (submission_id, action, user_id, notes, ip_address)
           VALUES (gen_random_uuid(), 'created', $1, $2, $3)`,
          [createdBy, `Created admin user: ${email}`, null]
        );

        logger.info('Admin user created', {
          newUserId: result.rows[0].id,
          email,
          role,
          createdBy
        });

        return {
          success: true,
          user: {
            id: result.rows[0].id,
            email,
            role,
            createdAt: result.rows[0].created_at
          }
        };

      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Create admin user error:', error);
      return { success: false, message: 'Failed to create admin user' };
    }
  }

  /**
   * Change admin password
   */
  async changePassword(userId, currentPassword, newPassword, ipAddress) {
    try {
      const client = await pool.connect();
      try {
        // Get current password hash
        const result = await client.query(
          'SELECT password_hash FROM admin_users WHERE id = $1 AND is_active = true',
          [userId]
        );

        if (result.rows.length === 0) {
          return { success: false, message: 'User not found' };
        }

        // Verify current password
        const currentPasswordValid = await bcrypt.compare(
          currentPassword,
          result.rows[0].password_hash
        );

        if (!currentPasswordValid) {
          return { success: false, message: 'Current password is incorrect' };
        }

        // Hash new password
        const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

        // Update password
        await client.query(
          'UPDATE admin_users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
          [newPasswordHash, userId]
        );

        // Deactivate all sessions (force re-login)
        await client.query(
          'UPDATE session_tokens SET is_active = false WHERE user_id = $1',
          [userId]
        );

        logger.info('Password changed', { userId, ip: ipAddress });

        return { success: true, message: 'Password changed successfully' };

      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Change password error:', error);
      return { success: false, message: 'Failed to change password' };
    }
  }

  /**
   * Cleanup expired sessions
   */
  async cleanupExpiredSessions() {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          'DELETE FROM session_tokens WHERE expires_at < NOW() RETURNING COUNT(*)'
        );

        if (result.rows[0].count > 0) {
          logger.info(`Cleaned up ${result.rows[0].count} expired sessions`);
        }

      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('Session cleanup failed:', error);
    }
  }
}

// Create singleton instance
const authService = new AuthService();

// Schedule session cleanup every hour
setInterval(() => authService.cleanupExpiredSessions(), 60 * 60 * 1000);

module.exports = {
  authService,
  authenticate: (email, password, ip, userAgent) => authService.authenticate(email, password, ip, userAgent),
  validateSession: (token, ip) => authService.validateSession(token, ip),
  logout: (token) => authService.logout(token),
  refreshToken: (token, ip, userAgent) => authService.refreshToken(token, ip, userAgent),
  createAdminUser: (email, password, role, createdBy) => authService.createAdminUser(email, password, role, createdBy),
  changePassword: (userId, currentPassword, newPassword, ip) => authService.changePassword(userId, currentPassword, newPassword, ip)
};