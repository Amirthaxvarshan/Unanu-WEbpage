#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { pool, testConnection } = require('../src/config/database');

const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
  success: (msg) => console.log(`[SUCCESS] ${msg}`)
};

async function runMigration() {
  try {
    logger.info('Testing database connection...');
    await testConnection();

    logger.info('Running database migration...');

    // Read migration file
    const migrationPath = path.join(__dirname, '../migrations/001_initial_schema.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

    // Execute migration
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migrationSQL);
      await client.query('COMMIT');
      logger.success('Database migration completed successfully!');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // Verify tables were created
    const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    logger.info('Created tables:');
    result.rows.forEach(row => {
      logger.info(`  - ${row.table_name}`);
    });

  } catch (error) {
    logger.error(`Migration failed: ${error.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Check if this script is being run directly
if (require.main === module) {
  runMigration();
}

module.exports = { runMigration };