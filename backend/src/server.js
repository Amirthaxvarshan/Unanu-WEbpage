const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const { testConnection } = require('./config/database');
const { initializeRedis } = require('./config/redis');
const { cleanupExpiredLimits } = require('./middleware/rateLimiter');
require('dotenv').config();

const winston = require('winston');

// Create logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error'
    }),
    new winston.transports.File({
      filename: 'logs/combined.log'
    })
  ]
});

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false // Allow easier development
}));

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      process.env.CORS_ORIGIN || 'https://unanu.com',
      'http://localhost:3000',
      'http://localhost:8080',
      'http://127.0.0.1:5500' // For local development
    ];

    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

app.use(cors(corsOptions));

// Compression middleware
app.use(compression());

// Body parsing middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Logging middleware
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: {
      write: (message) => logger.info(message.trim())
    }
  }));
}

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();

  // Log request
  logger.info('Request received', {
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    timestamp: new Date().toISOString()
  });

  // Log response
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('Response sent', {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip
    });
  });

  next();
});

// Trust proxy for accurate IP addresses
app.set('trust proxy', 1);

// Health check endpoint (before routes)
app.get('/health', async (req, res) => {
  try {
    // Check database connection
    const dbConnected = await testConnection().then(() => true).catch(() => false);

    // Check Redis connection
    const { isRedisAvailable } = require('./config/redis');
    const redisConnected = isRedisAvailable();

    const status = {
      success: true,
      service: 'UNANU Contact Backend',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      connections: {
        database: dbConnected,
        redis: redisConnected
      }
    };

    res.status(dbConnected ? 200 : 503).json(status);

  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      success: false,
      message: 'Service unavailable'
    });
  }
});

// API routes
const contactRoutes = require('./routes/contact');
app.use('/api/contact', contactRoutes);

// Static file serving for admin dashboard (if needed)
app.use('/admin', express.static('public/admin'));

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'UNANU Contact Backend API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      contact: '/api/contact',
      documentation: '/api/contact/docs'
    }
  });
});

// API documentation endpoint
app.get('/api/contact/docs', (req, res) => {
  res.json({
    success: true,
    message: 'UNANU Contact Backend API Documentation',
    version: '1.0.0',
    endpoints: {
      public: {
        'POST /api/contact': 'Submit contact form',
        'GET /api/contact/health': 'API health check',
        'GET /api/contact/csrf-token': 'Get CSRF token'
      },
      authentication: {
        'POST /api/contact/auth/login': 'Admin login',
        'POST /api/contact/auth/logout': 'Admin logout',
        'POST /api/contact/auth/refresh': 'Refresh token'
      },
      admin: {
        'GET /api/contact/admin/submissions': 'List submissions',
        'GET /api/contact/admin/submissions/:id': 'Get submission details',
        'PATCH /api/contact/admin/submissions/:id/status': 'Update submission status',
        'DELETE /api/contact/admin/submissions/:id': 'Delete submission',
        'GET /api/contact/admin/stats': 'Get statistics',
        'GET /api/contact/admin/export': 'Export submissions',
        'GET /api/contact/admin/system/status': 'System status'
      }
    },
    security: {
      authentication: 'JWT Bearer Token',
      rateLimit: 'Enabled',
      encryption: 'AES-256-GCM',
      validation: 'Input validation and sanitization'
    }
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method
  });
});

// Global error handler
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  // Don't leak error details in production
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : error.message;

  res.status(error.status || 500).json({
    success: false,
    message,
    ...(process.env.NODE_ENV !== 'production' && { stack: error.stack })
  });
});

// Graceful shutdown handler
const gracefulShutdown = (signal) => {
  logger.info(`Received ${signal}, starting graceful shutdown...`);

  server.close(() => {
    logger.info('HTTP server closed');

    // Close database connections
    const { pool } = require('./config/database');
    pool.end(() => {
      logger.info('Database pool closed');
    });

    // Close Redis connection
    const { closeRedis } = require('./config/redis');
    closeRedis().then(() => {
      logger.info('Redis connection closed');
    });

    process.exit(0);
  });

  // Force close after 30 seconds
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 30000);
};

// Handle process signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

// Start server
let server;

async function startServer() {
  try {
    logger.info('Starting UNANU Contact Backend Server...');

    // Test database connection
    logger.info('Testing database connection...');
    await testConnection();

    // Initialize Redis
    logger.info('Initializing Redis connection...');
    await initializeRedis();

    // Create logs directory if it doesn't exist
    const fs = require('fs');
    if (!fs.existsSync('logs')) {
      fs.mkdirSync('logs');
    }

    // Start HTTP server
    server = app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`, {
        environment: process.env.NODE_ENV || 'development',
        port: PORT,
        pid: process.pid
      });
    });

    // Schedule cleanup tasks
    setInterval(cleanupExpiredLimits, 60 * 60 * 1000); // Every hour

    logger.info('UNANU Contact Backend Server started successfully');

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
if (require.main === module) {
  startServer();
}

module.exports = app;