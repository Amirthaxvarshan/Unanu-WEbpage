const { validateSession } = require('../services/auth');
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
 * Middleware to authenticate JWT token
 */
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access token required'
      });
    }

    // Validate token and session
    const session = await validateSession(token, req.ip);

    if (!session.valid) {
      return res.status(401).json({
        success: false,
        message: session.message || 'Invalid or expired token'
      });
    }

    // Attach user info to request
    req.user = session.user;
    req.sessionId = session.sessionId;

    next();

  } catch (error) {
    logger.error('Authentication middleware error:', error);
    return res.status(401).json({
      success: false,
      message: 'Authentication failed'
    });
  }
};

/**
 * Middleware to require specific role
 */
const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      logger.warn('Access denied - insufficient role', {
        userId: req.user.id,
        userRole: req.user.role,
        requiredRoles: allowedRoles,
        ip: req.ip
      });

      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions'
      });
    }

    next();
  };
};

/**
 * Middleware to require admin role
 */
const requireAdmin = requireRole(['admin']);

/**
 * Middleware to require moderator or admin role
 */
const requireModerator = requireRole(['admin', 'moderator']);

/**
 * Optional authentication - doesn't fail if no token
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
      const session = await validateSession(token, req.ip);
      if (session.valid) {
        req.user = session.user;
        req.sessionId = session.sessionId;
      }
    }

    next();

  } catch (error) {
    // Optional auth shouldn't fail the request
    logger.debug('Optional authentication failed:', error);
    next();
  }
};

/**
 * Middleware to check if user can access specific submission
 */
const canAccessSubmission = async (req, res, next) => {
  try {
    const submissionId = req.params.id || req.params.submissionId;
    if (!submissionId) {
      return res.status(400).json({
        success: false,
        message: 'Submission ID required'
      });
    }

    // Admin users can access all submissions
    if (req.user.role === 'admin') {
      return next();
    }

    // Moderators can access all submissions (in this implementation)
    // This could be restricted further if needed
    if (req.user.role === 'moderator') {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: 'Insufficient permissions to access this submission'
    });

  } catch (error) {
    logger.error('Submission access check error:', error);
    return res.status(500).json({
      success: false,
      message: 'Access check failed'
    });
  }
};

/**
 * Rate limiting middleware specifically for authenticated users
 */
const authenticatedRateLimit = (maxRequests = 100, windowMs = 60 * 1000) => {
  const requests = new Map();

  return (req, res, next) => {
    if (!req.user) {
      return next(); // Skip if not authenticated
    }

    const key = `${req.user.id}:${Math.floor(Date.now() / windowMs)}`;
    const count = requests.get(key) || 0;

    if (count >= maxRequests) {
      return res.status(429).json({
        success: false,
        message: 'Too many requests'
      });
    }

    requests.set(key, count + 1);

    // Clean up old entries
    setTimeout(() => {
      requests.delete(key);
    }, windowMs * 2);

    next();
  };
};

/**
 * Middleware to check session activity and update last activity
 */
const updateSessionActivity = async (req, res, next) => {
  try {
    if (req.user && req.sessionId) {
      // This would update the session's last_activity timestamp
      // Implementation depends on your session management strategy
      logger.debug('Session activity updated', {
        userId: req.user.id,
        sessionId: req.sessionId
      });
    }
    next();
  } catch (error) {
    logger.debug('Session activity update failed:', error);
    next();
  }
};

/**
 * Middleware to log admin actions
 */
const logAdminAction = (action) => {
  return (req, res, next) => {
    // Store action info for later logging
    req.adminAction = {
      action,
      userId: req.user?.id,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      timestamp: new Date()
    };

    next();
  };
};

/**
 * Middleware to validate session hasn't been hijacked
 */
const validateSessionSecurity = async (req, res, next) => {
  try {
    if (!req.user || !req.sessionId) {
      return next();
    }

    // Check for suspicious patterns
    const userAgent = req.get('User-Agent');
    const suspiciousPatterns = [
      /bot/i,
      /crawler/i,
      /spider/i,
      /scraper/i
    ];

    const isSuspicious = suspiciousPatterns.some(pattern => pattern.test(userAgent));

    if (isSuspicious) {
      logger.warn('Suspicious user agent detected', {
        userId: req.user.id,
        userAgent,
        ip: req.ip
      });

      // Could implement additional security measures here
      // Such as requiring re-authentication
    }

    next();
  } catch (error) {
    logger.error('Session security validation error:', error);
    next();
  }
};

/**
 * Middleware to prevent concurrent sessions
 */
const preventConcurrentSessions = async (req, res, next) => {
  try {
    // This would implement logic to prevent multiple concurrent sessions
    // For now, we'll allow concurrent sessions but log them
    if (req.user) {
      logger.debug('User session active', {
        userId: req.user.id,
        ip: req.ip
      });
    }

    next();
  } catch (error) {
    logger.error('Concurrent session check error:', error);
    next();
  }
};

module.exports = {
  authenticateToken,
  requireRole,
  requireAdmin,
  requireModerator,
  optionalAuth,
  canAccessSubmission,
  authenticatedRateLimit,
  updateSessionActivity,
  logAdminAction,
  validateSessionSecurity,
  preventConcurrentSessions
};