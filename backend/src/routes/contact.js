const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

// Import middleware
const {
  validateContactSubmission,
  validateStatusUpdate,
  handleValidationErrors,
  validateContentType,
  preventXSS
} = require('../middleware/validation');

const {
  contactFormRateLimit,
  adminRateLimit,
  loginRateLimit
} = require('../middleware/rateLimiter');

const {
  authenticateToken,
  requireAdmin,
  requireModerator,
  canAccessSubmission,
  logAdminAction
} = require('../middleware/auth');

// Import controllers
const {
  submitContactForm,
  getSubmissions,
  getSubmission,
  updateSubmissionStatus,
  deleteSubmission,
  getSubmissionStats,
  exportSubmissions
} = require('../controllers/contactController');

// Import services
const { sendStatusChangeNotification } = require('../services/email');
const { logSecurityEvent } = require('../services/audit');

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Contact API is running',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Public contact form submission endpoint
router.post('/',
  // Apply rate limiting
  ...contactFormRateLimit,

  // Security middleware
  validateContentType(['application/json', 'multipart/form-data']),
  preventXSS,

  // Validation middleware
  validateContactSubmission,
  handleValidationErrors,

  // Controller
  submitContactForm
);

// Admin authentication routes
router.post('/auth/login',
  loginRateLimit,
  validateContentType(['application/json']),
  require('../controllers/authController').login
);

router.post('/auth/logout',
  authenticateToken,
  require('../controllers/authController').logout
);

router.post('/auth/refresh',
  authenticateToken,
  require('../controllers/authController').refreshToken
);

// Protected admin routes
router.use('/admin', authenticateToken);

// Get all submissions (moderator+)
router.get('/admin/submissions',
  adminRateLimit,
  requireModerator,
  logAdminAction('view_submissions'),
  getSubmissions
);

// Get submission statistics (moderator+)
router.get('/admin/stats',
  adminRateLimit,
  requireModerator,
  logAdminAction('view_stats'),
  getSubmissionStats
);

// Get single submission (moderator+)
router.get('/admin/submissions/:id',
  adminRateLimit,
  requireModerator,
  canAccessSubmission,
  logAdminAction('view_submission'),
  getSubmission
);

// Update submission status (moderator+)
router.patch('/admin/submissions/:id/status',
  adminRateLimit,
  requireModerator,
  canAccessSubmission,
  validateContentType(['application/json']),
  validateStatusUpdate,
  handleValidationErrors,
  logAdminAction('update_status'),
  async (req, res) => {
    try {
      const { status, notes } = req.body;
      const { id } = req.params;

      // Call the update controller
      await updateSubmissionStatus(req, res);

      // If update was successful, send email notification
      if (res.statusCode === 200) {
        // Get current status to compare
        const { pool } = require('../config/database');
        const client = await pool.connect();
        try {
          const result = await client.query('SELECT status FROM contact_submissions WHERE id = $1', [id]);
          if (result.rows.length > 0) {
            const oldStatus = result.rows[0].status;

            // Send notification if status changed
            if (oldStatus !== status) {
              await sendStatusChangeNotification(id, oldStatus, status, notes);
            }
          }
        } finally {
          client.release();
        }
      }

    } catch (error) {
      // Error already handled by the controller
    }
  }
);

// Delete submission (admin only)
router.delete('/admin/submissions/:id',
  adminRateLimit,
  requireAdmin,
  canAccessSubmission,
  logAdminAction('delete_submission'),
  deleteSubmission
);

// Export submissions (moderator+)
router.get('/admin/export',
  adminRateLimit,
  requireModerator,
  logAdminAction('export_submissions'),
  exportSubmissions
);

// Get audit trail for submission (moderator+)
router.get('/admin/submissions/:id/audit',
  adminRateLimit,
  requireModerator,
  canAccessSubmission,
  logAdminAction('view_audit_trail'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { getAuditTrail } = require('../services/audit');

      const auditTrail = await getAuditTrail(id);

      res.json({
        success: true,
        data: auditTrail
      });

    } catch (error) {
      const winston = require('winston');
      winston.createLogger().error('Get audit trail error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve audit trail'
      });
    }
  }
);

// Admin user management (admin only)
router.post('/admin/users',
  adminRateLimit,
  requireAdmin,
  logAdminAction('create_user'),
  validateContentType(['application/json']),
  require('../controllers/userController').createUser
);

router.get('/admin/users',
  adminRateLimit,
  requireAdmin,
  logAdminAction('view_users'),
  require('../controllers/userController').getUsers
);

router.patch('/admin/users/:id/password',
  adminRateLimit,
  requireAdmin,
  logAdminAction('change_password'),
  validateContentType(['application/json']),
  require('../controllers/userController').changePassword
);

// System configuration and monitoring (admin only)
router.get('/admin/system/status',
  adminRateLimit,
  requireAdmin,
  logAdminAction('view_system_status'),
  async (req, res) => {
    try {
      const { getStatus } = require('../services/email');
      const { isRedisAvailable } = require('../config/redis');
      const { testConnection } = require('../config/database');

      const [emailStatus, redisStatus, dbStatus] = await Promise.allSettled([
        getStatus(),
        Promise.resolve(isRedisAvailable()),
        testConnection()
      ]);

      res.json({
        success: true,
        data: {
          email: emailStatus.status === 'fulfilled' ? emailStatus.value : { initialized: false },
          redis: redisStatus.status === 'fulfilled' ? redisStatus.value : false,
          database: dbStatus.status === 'fulfilled' ? { connected: true } : { connected: false },
          timestamp: new Date().toISOString()
        }
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Failed to get system status'
      });
    }
  }
);

// Test email endpoint (admin only)
router.post('/admin/test-email',
  adminRateLimit,
  requireAdmin,
  validateContentType(['application/json']),
  logAdminAction('test_email'),
  async (req, res) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          message: 'Email address is required'
        });
      }

      const { sendTestEmail } = require('../services/email');
      await sendTestEmail(email);

      res.json({
        success: true,
        message: 'Test email sent successfully'
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Failed to send test email'
      });
    }
  }
);

// Security event reporting
router.post('/security/report',
  // Optional authentication - can be called by system components
  require('../middleware/auth').optionalAuth,
  validateContentType(['application/json']),
  async (req, res) => {
    try {
      const { event, details } = req.body;

      if (!event) {
        return res.status(400).json({
          success: false,
          message: 'Event type is required'
        });
      }

      await logSecurityEvent(event, {
        ...details,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        userId: req.user?.id
      });

      res.json({
        success: true,
        message: 'Security event logged'
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        message: 'Failed to log security event'
      });
    }
  }
);

// CSRF token endpoint (if implementing CSRF protection)
router.get('/csrf-token', (req, res) => {
  // Generate and return CSRF token
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');

  // Store token in session (if using sessions)
  req.session = req.session || {};
  req.session.csrfToken = token;

  res.json({
    success: true,
    token
  });
});

// Error handling middleware
router.use((error, req, res, next) => {
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

  logger.error('Route error:', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  // Log security event for suspicious errors
  if (error.status === 429 || error.status === 403) {
    logSecurityEvent('rate_limit_exceeded', {
      url: req.url,
      method: req.method,
      error: error.message
    });
  }

  res.status(error.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : error.message
  });
});

module.exports = router;