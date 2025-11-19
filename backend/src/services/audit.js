const { pool } = require('../config/database');
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
 * Audit logging service for tracking all system actions
 */
class AuditService {
  /**
   * Create audit log entry
   */
  static async createLog(submissionId, action, userId = null, oldStatus = null, newStatus = null, notes = null, ipAddress = null, userAgent = null) {
    try {
      const client = await pool.connect();
      try {
        await client.query(`
          INSERT INTO audit_log (
            submission_id,
            action,
            user_id,
            old_status,
            new_status,
            notes,
            ip_address,
            user_agent
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          submissionId,
          action,
          userId,
          oldStatus,
          newStatus,
          notes,
          ipAddress,
          userAgent
        ]);

        logger.info('Audit log created', {
          submissionId,
          action,
          userId,
          oldStatus,
          newStatus,
          ipAddress
        });

      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Failed to create audit log:', error);
      // Don't throw - audit log failure shouldn't break the main operation
    }
  }

  /**
   * Get audit trail for a submission
   */
  static async getAuditTrail(submissionId) {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT
            al.id,
            al.action,
            al.old_status,
            al.new_status,
            al.notes,
            al.ip_address,
            al.user_agent,
            al.created_at,
            au.email_encrypted
          FROM audit_log al
          LEFT JOIN admin_users au ON al.user_id = au.id
          WHERE al.submission_id = $1
          ORDER BY al.created_at ASC
        `, [submissionId]);

        // Decrypt email for display (masked)
        const { decryptData, maskEmail } = require('./encryption');
        const auditTrail = result.rows.map(entry => ({
          id: entry.id,
          action: entry.action,
          oldStatus: entry.old_status,
          newStatus: entry.new_status,
          notes: entry.notes,
          ipAddress: entry.ip_address,
          userAgent: entry.user_agent,
          createdAt: entry.created_at,
          userEmail: entry.email_encrypted ? maskEmail(decryptData(entry.email_encrypted)) : null
        }));

        return auditTrail;

      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Failed to get audit trail:', error);
      throw error;
    }
  }

  /**
   * Get admin user activity
   */
  static async getAdminActivity(userId, options = {}) {
    try {
      const {
        page = 1,
        limit = 50,
        action,
        dateFrom,
        dateTo
      } = options;

      const offset = (page - 1) * limit;
      let whereConditions = ['al.user_id = $1'];
      let queryParams = [userId];
      let paramIndex = 2;

      if (action) {
        whereConditions.push(`al.action = $${paramIndex++}`);
        queryParams.push(action);
      }

      if (dateFrom) {
        whereConditions.push(`al.created_at >= $${paramIndex++}`);
        queryParams.push(dateFrom);
      }

      if (dateTo) {
        whereConditions.push(`al.created_at <= $${paramIndex++}`);
        queryParams.push(dateTo);
      }

      const whereClause = whereConditions.join(' AND ');

      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT
            al.id,
            al.submission_id,
            al.action,
            al.old_status,
            al.new_status,
            al.notes,
            al.ip_address,
            al.user_agent,
            al.created_at,
            cs.name_encrypted
          FROM audit_log al
          LEFT JOIN contact_submissions cs ON al.submission_id = cs.id
          WHERE ${whereClause}
          ORDER BY al.created_at DESC
          LIMIT $${paramIndex++} OFFSET $${paramIndex++}
        `, [...queryParams, limit, offset]);

        return result.rows;

      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Failed to get admin activity:', error);
      throw error;
    }
  }

  /**
   * Get system-wide audit statistics
   */
  static async getAuditStats(options = {}) {
    try {
      const {
        dateFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
        dateTo = new Date()
      } = options;

      const client = await pool.connect();
      try {
        // Action counts
        const actionCounts = await client.query(`
          SELECT
            action,
            COUNT(*) as count
          FROM audit_log
          WHERE created_at BETWEEN $1 AND $2
          GROUP BY action
          ORDER BY count DESC
        `, [dateFrom, dateTo]);

        // User activity counts
        const userActivity = await client.query(`
          SELECT
            au.id,
            au.email_encrypted,
            COUNT(*) as action_count
          FROM audit_log al
          JOIN admin_users au ON al.user_id = au.id
          WHERE al.created_at BETWEEN $1 AND $2
          GROUP BY au.id, au.email_encrypted
          ORDER BY action_count DESC
          LIMIT 10
        `, [dateFrom, dateTo]);

        // Hourly activity for charts
        const hourlyActivity = await client.query(`
          SELECT
            DATE_TRUNC('hour', created_at) as hour,
            COUNT(*) as count
          FROM audit_log
          WHERE created_at BETWEEN $1 AND $2
          GROUP BY DATE_TRUNC('hour', created_at)
          ORDER BY hour DESC
          LIMIT 168 -- 7 days of hourly data
        `, [dateFrom, dateTo]);

        // Recent security events
        const securityEvents = await client.query(`
          SELECT
            al.action,
            al.notes,
            al.ip_address,
            al.created_at,
            au.email_encrypted
          FROM audit_log al
          LEFT JOIN admin_users au ON al.user_id = au.id
          WHERE al.created_at BETWEEN $1 AND $2
          AND (al.action = 'deleted' OR al.notes ILIKE '%spam%' OR al.notes ILIKE '%error%')
          ORDER BY al.created_at DESC
          LIMIT 20
        `, [dateFrom, dateTo]);

        return {
          actionCounts: actionCounts.rows,
          userActivity: userActivity.rows,
          hourlyActivity: hourlyActivity.rows,
          securityEvents: securityEvents.rows
        };

      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Failed to get audit stats:', error);
      throw error;
    }
  }

  /**
   * Log security events
   */
  static async logSecurityEvent(event, details = {}) {
    try {
      const client = await pool.connect();
      try {
        await client.query(`
          INSERT INTO audit_log (
            submission_id,
            action,
            notes,
            ip_address,
            user_agent
          ) VALUES (
            gen_random_uuid(),
            $1,
            $2,
            $3,
            $4
          )
        `, [
          'security_event',
          JSON.stringify({ event, ...details }),
          details.ipAddress,
          details.userAgent
        ]);

        logger.warn('Security event logged', {
          event,
          details
        });

      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Failed to log security event:', error);
    }
  }

  /**
   * Create audit log using database function
   */
  static async createAuditEntry(submissionId, action, userId = null, oldStatus = null, newStatus = null, notes = null, ipAddress = null, userAgent = null) {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT create_audit_entry($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          submissionId,
          action,
          userId,
          oldStatus,
          newStatus,
          notes,
          ipAddress,
          userAgent
        ]);

        return result.rows[0].create_audit_entry;

      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Failed to create audit entry:', error);
      throw error;
    }
  }

  /**
   * Cleanup old audit logs
   */
  static async cleanupOldLogs(retentionDays = 365) {
    try {
      const client = await pool.connect();
      try {
        const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

        const result = await client.query(
          'DELETE FROM audit_log WHERE created_at < $1 RETURNING COUNT(*)',
          [cutoffDate]
        );

        const deletedCount = result.rows[0].count;
        if (deletedCount > 0) {
          logger.info(`Cleaned up ${deletedCount} old audit log entries`);
        }

        return deletedCount;

      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Failed to cleanup old audit logs:', error);
      throw error;
    }
  }

  /**
   * Export audit logs
   */
  static async exportAuditLogs(options = {}) {
    try {
      const {
        submissionId,
        userId,
        action,
        dateFrom,
        dateTo,
        limit = 10000
      } = options;

      let whereConditions = [];
      let queryParams = [];
      let paramIndex = 1;

      if (submissionId) {
        whereConditions.push(`al.submission_id = $${paramIndex++}`);
        queryParams.push(submissionId);
      }

      if (userId) {
        whereConditions.push(`al.user_id = $${paramIndex++}`);
        queryParams.push(userId);
      }

      if (action) {
        whereConditions.push(`al.action = $${paramIndex++}`);
        queryParams.push(action);
      }

      if (dateFrom) {
        whereConditions.push(`al.created_at >= $${paramIndex++}`);
        queryParams.push(dateFrom);
      }

      if (dateTo) {
        whereConditions.push(`al.created_at <= $${paramIndex++}`);
        queryParams.push(dateTo);
      }

      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT
            al.id,
            al.submission_id,
            al.action,
            al.old_status,
            al.new_status,
            al.notes,
            al.ip_address,
            al.user_agent,
            al.created_at,
            au.email_encrypted
          FROM audit_log al
          LEFT JOIN admin_users au ON al.user_id = au.id
          ${whereClause}
          ORDER BY al.created_at DESC
          LIMIT $${paramIndex}
        `, [...queryParams, limit]);

        return result.rows;

      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Failed to export audit logs:', error);
      throw error;
    }
  }
}

// Schedule cleanup of old audit logs (run daily)
setInterval(() => {
  const retentionDays = parseInt(process.env.AUDIT_RETENTION_DAYS) || 365;
  AuditService.cleanupOldLogs(retentionDays)
    .catch(error => logger.error('Scheduled audit cleanup failed:', error));
}, 24 * 60 * 60 * 1000);

module.exports = {
  AuditService,
  createAuditEntry: AuditService.createAuditEntry,
  getAuditTrail: AuditService.getAuditTrail,
  getAdminActivity: AuditService.getAdminActivity,
  getAuditStats: AuditService.getAuditStats,
  logSecurityEvent: AuditService.logSecurityEvent,
  exportAuditLogs: AuditService.exportAuditLogs
};