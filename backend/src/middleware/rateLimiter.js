const { isRedisAvailable, getRedisClient } = require('../config/redis');
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

// Rate limiting configuration
const RATE_LIMITS = {
  // IP-based limits
  IP_PER_HOUR: 3,
  IP_PER_DAY: 20,

  // Email-based limits
  EMAIL_PER_DAY: 5,

  // Global limits
  GLOBAL_PER_MINUTE: 100,

  // Login attempts
  LOGIN_PER_15_MIN: 5,

  // Admin actions
  ADMIN_PER_MINUTE: 30
};

/**
 * Redis-based rate limiter
 */
class RedisRateLimiter {
  constructor(keyPrefix, windowMs, maxRequests) {
    this.keyPrefix = keyPrefix;
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  async isAllowed(identifier) {
    if (!isRedisAvailable()) {
      // Fallback to database or memory-based limiting
      return this.fallbackIsAllowed(identifier);
    }

    const redis = getRedisClient();
    const key = `${this.keyPrefix}:${identifier}`;
    const now = Date.now();
    const windowStart = now - this.windowMs;

    try {
      // Use Redis pipeline for atomic operations
      const pipeline = redis.multi();

      // Remove old entries
      pipeline.zRemRangeByScore(key, 0, windowStart);

      // Add current request
      pipeline.zAdd(key, { score: now, value: `${now}-${Math.random()}` });

      // Get current count
      pipeline.zCard(key);

      // Set expiration
      pipeline.expire(key, Math.ceil(this.windowMs / 1000) + 60);

      const results = await pipeline.exec();
      const currentCount = results[2].response;

      logger.debug('Rate limit check', {
        identifier,
        keyPrefix: this.keyPrefix,
        currentCount,
        maxRequests: this.maxRequests,
        windowMs: this.windowMs
      });

      return {
        allowed: currentCount <= this.maxRequests,
        count: currentCount,
        remainingCount: Math.max(0, this.maxRequests - currentCount),
        resetTime: new Date(now + this.windowMs)
      };

    } catch (error) {
      logger.error('Redis rate limiter error:', error);
      // Fail open - allow request if Redis fails
      return {
        allowed: true,
        count: 0,
        remainingCount: this.maxRequests,
        resetTime: new Date(Date.now() + this.windowMs)
      };
    }
  }

  async fallbackIsAllowed(identifier) {
    try {
      const client = await pool.connect();
      const now = new Date();
      const windowStart = new Date(now.getTime() - this.windowMs);
      const windowEnd = new Date(now.getTime() + this.windowMs);

      try {
        // Clean up old entries
        await client.query(
          'DELETE FROM rate_limits WHERE window_end < $1',
          [now]
        );

        // Get current count
        const result = await client.query(
          `SELECT request_count FROM rate_limits
           WHERE identifier = $1 AND identifier_type = $2 AND window_start >= $3`,
          [identifier, this.keyPrefix, windowStart]
        );

        let currentCount = 0;
        if (result.rows.length > 0) {
          currentCount = result.rows[0].request_count;
        }

        const allowed = currentCount < this.maxRequests;

        if (allowed) {
          // Increment counter
          if (result.rows.length > 0) {
            await client.query(
              `UPDATE rate_limits
               SET request_count = request_count + 1, updated_at = $1
               WHERE identifier = $2 AND identifier_type = $3`,
              [now, identifier, this.keyPrefix]
            );
          } else {
            await client.query(
              `INSERT INTO rate_limits (identifier, identifier_type, request_count, window_start, window_end)
               VALUES ($1, $2, $3, $4, $5)`,
              [identifier, this.keyPrefix, 1, windowStart, windowEnd]
            );
          }
        }

        return {
          allowed,
          count: currentCount + 1,
          remainingCount: Math.max(0, this.maxRequests - (currentCount + 1)),
          resetTime: windowEnd
        };

      } finally {
        client.release();
      }

    } catch (error) {
      logger.error('Database rate limiter error:', error);
      // Fail open
      return {
        allowed: true,
        count: 0,
        remainingCount: this.maxRequests,
        resetTime: new Date(Date.now() + this.windowMs)
      };
    }
  }
}

/**
 * Create rate limiting middleware
 */
const createRateLimit = (options = {}) => {
  const {
    keyPrefix = 'general',
    windowMs = 60 * 60 * 1000, // 1 hour
    maxRequests = RATE_LIMITS.IP_PER_HOUR,
    keyGenerator = (req) => req.ip,
    skipSuccessfulRequests = false,
    skipFailedRequests = false,
    message = 'Too many requests. Please try again later.'
  } = options;

  const limiter = new RedisRateLimiter(keyPrefix, windowMs, maxRequests);

  return async (req, res, next) => {
    try {
      const identifier = keyGenerator(req);
      const result = await limiter.isAllowed(identifier);

      // Add rate limit headers
      res.set({
        'X-RateLimit-Limit': maxRequests,
        'X-RateLimit-Remaining': result.remainingCount,
        'X-RateLimit-Reset': Math.ceil(result.resetTime.getTime() / 1000)
      });

      if (!result.allowed) {
        logger.warn('Rate limit exceeded', {
          identifier,
          keyPrefix,
          ip: req.ip,
          userAgent: req.get('User-Agent'),
          count: result.count
        });

        return res.status(429).json({
          success: false,
          message,
          retryAfter: Math.ceil((result.resetTime.getTime() - Date.now()) / 1000)
        });
      }

      next();

    } catch (error) {
      logger.error('Rate limiting middleware error:', error);
      // Fail open - allow request
      next();
    }
  };
};

/**
 * Contact form rate limiting
 */
const contactFormRateLimit = [
  // IP-based limiting
  createRateLimit({
    keyPrefix: 'contact_ip',
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: RATE_LIMITS.IP_PER_HOUR,
    keyGenerator: (req) => `ip:${req.ip}`
  }),

  // Email-based limiting
  createRateLimit({
    keyPrefix: 'contact_email',
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    maxRequests: RATE_LIMITS.EMAIL_PER_DAY,
    keyGenerator: (req) => `email:${req.body.email?.toLowerCase()}`,
    skipFailedRequests: true // Only count successful submissions
  }),

  // Daily IP limiting
  createRateLimit({
    keyPrefix: 'contact_ip_daily',
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    maxRequests: RATE_LIMITS.IP_PER_DAY,
    keyGenerator: (req) => `ip:${req.ip}`
  })
];

/**
 * Login rate limiting
 */
const loginRateLimit = createRateLimit({
  keyPrefix: 'login',
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: RATE_LIMITS.LOGIN_PER_15_MIN,
  keyGenerator: (req) => `login:${req.ip}:${req.body.email?.toLowerCase()}`,
  message: 'Too many login attempts. Please try again in 15 minutes.'
});

/**
 * Admin action rate limiting
 */
const adminRateLimit = createRateLimit({
  keyPrefix: 'admin',
  windowMs: 60 * 1000, // 1 minute
  maxRequests: RATE_LIMITS.ADMIN_PER_MINUTE,
  keyGenerator: (req) => `admin:${req.user?.id || req.ip}`
});

/**
 * Global rate limiting to prevent abuse
 */
const globalRateLimit = createRateLimit({
  keyPrefix: 'global',
  windowMs: 60 * 1000, // 1 minute
  maxRequests: RATE_LIMITS.GLOBAL_PER_MINUTE,
  keyGenerator: () => 'global'
});

/**
 * Progressive rate limiting for repeated offenses
 */
const progressiveRateLimit = (req, res, next) => {
  const baseLimit = RATE_LIMITS.IP_PER_HOUR;
  const multiplier = Math.floor(Math.random() * 3) + 1; // 1-3x multiplier

  // Check if this IP has been flagged before
  // This could be enhanced with a database table tracking flagged IPs

  const progressiveLimiter = createRateLimit({
    keyPrefix: 'progressive',
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: baseLimit * multiplier,
    keyGenerator: (req) => `progressive:${req.ip}`,
    message: `Rate limit temporarily reduced due to unusual activity. Please try again later.`
  });

  progressiveLimiter(req, res, next);
};

/**
 * Cleanup expired rate limit entries
 */
const cleanupExpiredLimits = async () => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'DELETE FROM rate_limits WHERE window_end < NOW() RETURNING COUNT(*)'
      );

      if (result.rows[0].count > 0) {
        logger.info(`Cleaned up ${result.rows[0].count} expired rate limit entries`);
      }
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Rate limit cleanup failed:', error);
  }
};

// Schedule cleanup every hour
setInterval(cleanupExpiredLimits, 60 * 60 * 1000);

module.exports = {
  createRateLimit,
  contactFormRateLimit,
  loginRateLimit,
  adminRateLimit,
  globalRateLimit,
  progressiveRateLimit,
  cleanupExpiredLimits,
  RATE_LIMITS
};