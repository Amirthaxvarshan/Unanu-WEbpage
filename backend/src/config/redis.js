const redis = require('redis');
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

let redisClient = null;

const createRedisClient = async () => {
  try {
    redisClient = redis.createClient({
      url: process.env.RATE_LIMIT_REDIS_URL || 'redis://localhost:6379',
      password: process.env.REDIS_PASSWORD || undefined,
      database: parseInt(process.env.REDIS_DB) || 0,
      retry_strategy: (options) => {
        if (options.error && options.error.code === 'ECONNREFUSED') {
          logger.error('Redis server connection refused');
          return new Error('Redis server connection refused');
        }
        if (options.total_retry_time > 1000 * 60 * 60) {
          logger.error('Redis retry time exhausted');
          return new Error('Retry time exhausted');
        }
        if (options.attempt > 10) {
          logger.error('Redis retry attempts exhausted');
          return undefined;
        }
        // Retry after min(trying * 100, 3000) milliseconds
        return Math.min(options.attempt * 100, 3000);
      }
    });

    redisClient.on('error', (err) => {
      logger.error('Redis client error:', err);
    });

    redisClient.on('connect', () => {
      logger.info('Redis client connected');
    });

    redisClient.on('ready', () => {
      logger.info('Redis client ready');
    });

    await redisClient.connect();
    return redisClient;
  } catch (err) {
    logger.error('Failed to create Redis client:', err);
    // Graceful fallback - return null to disable rate limiting
    return null;
  }
};

const initializeRedis = async () => {
  redisClient = await createRedisClient();
};

const getRedisClient = () => redisClient;

const isRedisAvailable = () => redisClient !== null && redisClient.isOpen;

// Graceful shutdown
const closeRedis = async () => {
  if (redisClient && redisClient.isOpen) {
    await redisClient.quit();
    logger.info('Redis client closed');
  }
};

module.exports = {
  createRedisClient,
  initializeRedis,
  getRedisClient,
  isRedisAvailable,
  closeRedis
};