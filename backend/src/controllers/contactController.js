const { pool } = require('../config/database');
const { encryptSubmissionData } = require('../services/encryption');
const { analyzeSubmission, reportSpam } = require('../services/spamProtection');
const { createAuditEntry } = require('../services/audit');
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
 * Handle contact form submission
 */
const submitContactForm = async (req, res) => {
  const client = await pool.connect();
  let submissionId = null;

  try {
    const { name, email, company, phone, message, consent, honeypot } = req.body;
    const ipAddress = req.ip;
    const userAgent = req.get('User-Agent');

    // Analyze for spam
    const spamAnalysis = await analyzeSubmission(
      { name, email, company, phone, message, consent, honeypot },
      ipAddress,
      userAgent
    );

    // Reject if high confidence spam
    if (spamAnalysis.shouldReject) {
      logger.warn('Submission rejected - high confidence spam', {
        ip: ipAddress,
        email,
        score: spamAnalysis.score,
        reasons: spamAnalysis.reasons
      });

      await reportSpam(ipAddress, email, {
        score: spamAnalysis.score,
        reasons: spamAnalysis.reasons,
        submissionData: { name, email, company, phone, message }
      });

      return res.status(429).json({
        success: false,
        message: 'Submission rejected as spam'
      });
    }

    await client.query('BEGIN');

    // Encrypt submission data
    const encryptedData = encryptSubmissionData({
      name,
      email,
      company: company || null,
      phone: phone || null,
      message
    });

    // Determine initial status
    const initialStatus = spamAnalysis.isSpam ? 'spam' : 'new';

    // Insert submission
    const result = await client.query(`
      INSERT INTO contact_submissions (
        name_encrypted,
        email_encrypted,
        company_encrypted,
        phone_encrypted,
        message_encrypted,
        ip_address,
        user_agent,
        status,
        honeypot_filled,
        spam_score,
        consent_given
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, created_at
    `, [
      encryptedData.name_encrypted,
      encryptedData.email_encrypted,
      encryptedData.company_encrypted,
      encryptedData.phone_encrypted,
      encryptedData.message_encrypted,
      ipAddress,
      userAgent,
      initialStatus,
      honeypot && honeypot.trim() !== '',
      spamAnalysis.score,
      consent
    ]);

    submissionId = result.rows[0].id;

    // Create audit log entry
    await createAuditEntry(
      submissionId,
      'created',
      null, // system action (no user)
      null,
      initialStatus,
      spamAnalysis.isSpam ? `Auto-marked as spam (score: ${spamAnalysis.score})` : null,
      ipAddress,
      userAgent
    );

    await client.query('COMMIT');

    logger.info('Contact submission received', {
      submissionId,
      ip: ipAddress,
      status: initialStatus,
      spamScore: spamAnalysis.score,
      isSpam: spamAnalysis.isSpam
    });

    // Trigger email notification (handled asynchronously)
    if (!spamAnalysis.isSpam) {
      setImmediate(() => {
        require('../services/email').sendNewSubmissionNotification(submissionId)
          .catch(err => logger.error('Email notification failed:', err));
      });
    }

    res.status(200).json({
      success: true,
      message: 'Message received successfully',
      submissionId
    });

  } catch (error) {
    await client.query('ROLLBACK');

    logger.error('Contact submission error:', {
      error: error.message,
      stack: error.stack,
      ip: req.ip,
      body: req.body
    });

    // If we have a submission ID, log the error to audit
    if (submissionId) {
      try {
        await createAuditEntry(
          submissionId,
          'created',
          null,
          null,
          'error',
          `Submission failed: ${error.message}`,
          req.ip,
          req.get('User-Agent')
        );
      } catch (auditError) {
        logger.error('Failed to create audit entry for failed submission:', auditError);
      }
    }

    res.status(500).json({
      success: false,
      message: 'Server error. Please try again.'
    });

  } finally {
    client.release();
  }
};

/**
 * Get all submissions (admin only)
 */
const getSubmissions = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      search,
      dateFrom,
      dateTo,
      sortBy = 'created_at',
      sortOrder = 'DESC'
    } = req.query;

    const offset = (page - 1) * limit;
    let whereConditions = [];
    let queryParams = [];
    let paramIndex = 1;

    // Build WHERE conditions
    if (status) {
      whereConditions.push(`status = $${paramIndex++}`);
      queryParams.push(status);
    }

    if (search) {
      whereConditions.push(`(
        email_encrypted LIKE $${paramIndex++} OR
        name_encrypted LIKE $${paramIndex++} OR
        company_encrypted LIKE $${paramIndex++}
      )`);
      const searchTerm = `%${search}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm);
    }

    if (dateFrom) {
      whereConditions.push(`created_at >= $${paramIndex++}`);
      queryParams.push(dateFrom);
    }

    if (dateTo) {
      whereConditions.push(`created_at <= $${paramIndex++}`);
      queryParams.push(dateTo);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Validate sort column
    const validSortColumns = ['created_at', 'updated_at', 'status', 'spam_score'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
    const sortDirection = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const query = `
      SELECT
        id,
        status,
        spam_score,
        created_at,
        updated_at,
        processed_at,
        ip_address,
        CASE
          WHEN status = 'new' THEN 'blue'
          WHEN status = 'in_progress' THEN 'yellow'
          WHEN status = 'resolved' THEN 'green'
          WHEN status = 'spam' THEN 'red'
        END as status_color
      FROM contact_submissions
      ${whereClause}
      ORDER BY ${sortColumn} ${sortDirection}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    queryParams.push(limit, offset);

    const client = await pool.connect();
    try {
      const result = await client.query(query, queryParams);

      // Get total count for pagination
      const countQuery = `
        SELECT COUNT(*) as total
        FROM contact_submissions
        ${whereClause}
      `;
      const countResult = await client.query(countQuery, queryParams.slice(0, -2));
      const total = parseInt(countResult.rows[0].total);

      res.json({
        success: true,
        data: {
          submissions: result.rows,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            totalPages: Math.ceil(total / limit)
          }
        }
      });

    } finally {
      client.release();
    }

  } catch (error) {
    logger.error('Get submissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve submissions'
    });
  }
};

/**
 * Get single submission details
 */
const getSubmission = async (req, res) => {
  try {
    const { id } = req.params;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get submission details
      const result = await client.query(`
        SELECT
          id,
          name_encrypted,
          email_encrypted,
          company_encrypted,
          phone_encrypted,
          message_encrypted,
          status,
          spam_score,
          ip_address,
          user_agent,
          consent_given,
          created_at,
          updated_at,
          processed_at,
          honeypot_filled
        FROM contact_submissions
        WHERE id = $1
      `, [id]);

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: 'Submission not found'
        });
      }

      // Decrypt data
      const { decryptSubmissionData, maskEmail, maskPhone } = require('../services/encryption');
      const submission = result.rows[0];
      const decryptedData = decryptSubmissionData(submission);

      // Create audit log entry for viewing
      await createAuditEntry(
        id,
        'viewed',
        req.user.id,
        null,
        null,
        null,
        req.ip,
        req.get('User-Agent')
      );

      await client.query('COMMIT');

      // Prepare response with masked sensitive data for security
      const response = {
        id: submission.id,
        name: decryptedData.name,
        email: maskEmail(decryptedData.email), // Masked email
        company: decryptedData.company,
        phone: decryptedData.phone ? maskPhone(decryptedData.phone) : null, // Masked phone
        message: decryptedData.message,
        status: submission.status,
        spamScore: submission.spam_score,
        consentGiven: submission.consent_given,
        createdAt: submission.created_at,
        updatedAt: submission.updated_at,
        processedAt: submission.processed_at,
        ipAddress: submission.ip_address,
        userAgent: submission.user_agent,
        honeypotFilled: submission.honeypot_filled,
        statusColor: submission.status === 'new' ? 'blue' :
                    submission.status === 'in_progress' ? 'yellow' :
                    submission.status === 'resolved' ? 'green' : 'red'
      };

      res.json({
        success: true,
        data: response
      });

    } finally {
      client.release();
    }

  } catch (error) {
    logger.error('Get submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve submission'
    });
  }
};

/**
 * Update submission status
 */
const updateSubmissionStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get current status
      const currentResult = await client.query(
        'SELECT status FROM contact_submissions WHERE id = $1',
        [id]
      );

      if (currentResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: 'Submission not found'
        });
      }

      const oldStatus = currentResult.rows[0].status;

      // Update submission status
      const updateFields = ['updated_at = NOW()'];
      const updateValues = [];
      let paramIndex = 1;

      updateFields.push(`status = $${paramIndex++}`);
      updateValues.push(status);

      if (status === 'resolved' || status === 'in_progress') {
        updateFields.push(`processed_at = $${paramIndex++}`);
        updateValues.push(new Date());
      }

      updateValues.push(id);

      await client.query(`
        UPDATE contact_submissions
        SET ${updateFields.join(', ')}
        WHERE id = $${paramIndex}
      `, updateValues);

      // Create audit log entry
      await createAuditEntry(
        id,
        'updated',
        req.user.id,
        oldStatus,
        status,
        notes,
        req.ip,
        req.get('User-Agent')
      );

      await client.query('COMMIT');

      logger.info('Submission status updated', {
        submissionId: id,
        oldStatus,
        newStatus: status,
        updatedBy: req.user.id,
        notes
      });

      res.json({
        success: true,
        message: 'Submission updated successfully'
      });

    } finally {
      client.release();
    }

  } catch (error) {
    logger.error('Update submission status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update submission'
    });
  }
};

/**
 * Delete submission
 */
const deleteSubmission = async (req, res) => {
  try {
    const { id } = req.params;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get submission details for audit
      const result = await client.query(
        'SELECT status FROM contact_submissions WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: 'Submission not found'
        });
      }

      // Delete submission (cascade will handle audit logs)
      await client.query('DELETE FROM contact_submissions WHERE id = $1', [id]);

      // Create final audit entry before cascade deletion
      await client.query(`
        INSERT INTO audit_log (submission_id, action, user_id, notes, ip_address, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        id,
        'deleted',
        req.user.id,
        'Submission deleted by admin',
        req.ip,
        req.get('User-Agent')
      ]);

      await client.query('COMMIT');

      logger.info('Submission deleted', {
        submissionId: id,
        deletedBy: req.user.id,
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Submission deleted successfully'
      });

    } finally {
      client.release();
    }

  } catch (error) {
    logger.error('Delete submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete submission'
    });
  }
};

/**
 * Get submission statistics
 */
const getSubmissionStats = async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      // Get stats from the view
      const result = await client.query('SELECT * FROM submission_stats');

      // Get recent activity
      const recentActivity = await client.query(`
        SELECT
          cs.id,
          cs.status,
          cs.created_at,
          al.action,
          al.created_at as action_date
        FROM contact_submissions cs
        LEFT JOIN audit_log al ON cs.id = al.submission_id
        WHERE cs.created_at > NOW() - INTERVAL '7 days'
        ORDER BY cs.created_at DESC
        LIMIT 10
      `);

      res.json({
        success: true,
        data: {
          stats: result.rows[0],
          recentActivity: recentActivity.rows
        }
      });

    } finally {
      client.release();
    }

  } catch (error) {
    logger.error('Get submission stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve statistics'
    });
  }
};

/**
 * Export submissions to CSV
 */
const exportSubmissions = async (req, res) => {
  try {
    const { status, dateFrom, dateTo } = req.query;

    let whereConditions = [];
    let queryParams = [];
    let paramIndex = 1;

    if (status) {
      whereConditions.push(`status = $${paramIndex++}`);
      queryParams.push(status);
    }

    if (dateFrom) {
      whereConditions.push(`created_at >= $${paramIndex++}`);
      queryParams.push(dateFrom);
    }

    if (dateTo) {
      whereConditions.push(`created_at <= $${paramIndex++}`);
      queryParams.push(dateTo);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const query = `
      SELECT
        id,
        status,
        spam_score,
        created_at,
        updated_at,
        ip_address
      FROM contact_submissions
      ${whereClause}
      ORDER BY created_at DESC
    `;

    const client = await pool.connect();
    try {
      const result = await client.query(query, queryParams);

      // Convert to CSV
      const csv = [
        'ID,Status,Spam Score,Created At,Updated At,IP Address',
        ...result.rows.map(row => [
          row.id,
          row.status,
          row.spam_score,
          row.created_at,
          row.updated_at,
          row.ip_address
        ].join(','))
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=submissions.csv');
      res.send(csv);

    } finally {
      client.release();
    }

  } catch (error) {
    logger.error('Export submissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to export submissions'
    });
  }
};

module.exports = {
  submitContactForm,
  getSubmissions,
  getSubmission,
  updateSubmissionStatus,
  deleteSubmission,
  getSubmissionStats,
  exportSubmissions
};