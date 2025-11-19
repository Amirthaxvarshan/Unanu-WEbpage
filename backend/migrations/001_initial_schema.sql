-- Initial Database Schema for UNANU Contact System
-- Created: 2025-11-19
-- Purpose: Secure contact form submission with encryption and audit logging

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create custom ENUM types
CREATE TYPE submission_status AS ENUM ('new', 'in_progress', 'resolved', 'spam');
CREATE TYPE audit_action AS ENUM ('created', 'viewed', 'updated', 'deleted');
CREATE TYPE admin_role AS ENUM ('admin', 'moderator');

-- Submissions table for storing contact form submissions
CREATE TABLE contact_submissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name_encrypted BYTEA NOT NULL,
    email_encrypted BYTEA NOT NULL,
    company_encrypted BYTEA,
    phone_encrypted BYTEA,
    message_encrypted BYTEA NOT NULL,
    ip_address INET NOT NULL,
    user_agent TEXT,
    status submission_status DEFAULT 'new',
    honeypot_filled BOOLEAN DEFAULT FALSE,
    spam_score DECIMAL(3,2) DEFAULT 0.0,
    consent_given BOOLEAN NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for submissions table
CREATE INDEX idx_submissions_status ON contact_submissions(status);
CREATE INDEX idx_submissions_created_at ON contact_submissions(created_at);
CREATE INDEX idx_submissions_ip_address ON contact_submissions(ip_address);
CREATE INDEX idx_submissions_spam_score ON contact_submissions(spam_score);

-- Audit log table for tracking all changes
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    submission_id UUID NOT NULL REFERENCES contact_submissions(id) ON DELETE CASCADE,
    action audit_action NOT NULL,
    user_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    old_status submission_status,
    new_status submission_status,
    notes TEXT,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for audit log
CREATE INDEX idx_audit_submission_id ON audit_log(submission_id);
CREATE INDEX idx_audit_user_id ON audit_log(user_id);
CREATE INDEX idx_audit_created_at ON audit_log(created_at);
CREATE INDEX idx_audit_action ON audit_log(action);

-- Admin users table for authentication
CREATE TABLE admin_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email_encrypted BYTEA NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role admin_role DEFAULT 'moderator',
    last_login TIMESTAMP WITH TIME ZONE,
    failed_login_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE
);

-- Indexes for admin users
CREATE INDEX idx_admin_users_email ON admin_users(email_encrypted);
CREATE INDEX idx_admin_users_role ON admin_users(role);
CREATE INDEX idx_admin_users_active ON admin_users(is_active);

-- Rate limiting table (fallback when Redis is unavailable)
CREATE TABLE rate_limits (
    id SERIAL PRIMARY KEY,
    identifier VARCHAR(255) NOT NULL,
    identifier_type VARCHAR(20) NOT NULL, -- 'ip' or 'email'
    request_count INTEGER NOT NULL DEFAULT 1,
    window_start TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    window_end TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(identifier, identifier_type, window_start, window_end)
);

-- Indexes for rate limiting
CREATE INDEX idx_rate_limits_identifier ON rate_limits(identifier, identifier_type);
CREATE INDEX idx_rate_limits_window_end ON rate_limits(window_end);

-- Session tokens table for enhanced security
CREATE TABLE session_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    ip_address INET,
    user_agent TEXT,
    last_activity TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for session tokens
CREATE INDEX idx_session_tokens_user_id ON session_tokens(user_id);
CREATE INDEX idx_session_tokens_hash ON session_tokens(token_hash);
CREATE INDEX idx_session_tokens_expires_at ON session_tokens(expires_at);

-- Create function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at timestamps
CREATE TRIGGER update_contact_submissions_updated_at BEFORE UPDATE ON contact_submissions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_admin_users_updated_at BEFORE UPDATE ON admin_users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_rate_limits_updated_at BEFORE UPDATE ON rate_limits
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to create audit log entries
CREATE OR REPLACE FUNCTION create_audit_entry(
    p_submission_id UUID,
    p_action audit_action,
    p_user_id UUID DEFAULT NULL,
    p_old_status submission_status DEFAULT NULL,
    p_new_status submission_status DEFAULT NULL,
    p_notes TEXT DEFAULT NULL,
    p_ip_address INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    audit_id UUID;
BEGIN
    INSERT INTO audit_log (
        submission_id, action, user_id, old_status, new_status,
        notes, ip_address, user_agent
    ) VALUES (
        p_submission_id, p_action, p_user_id, p_old_status, p_new_status,
        p_notes, p_ip_address, p_user_agent
    ) RETURNING id INTO audit_id;

    RETURN audit_id;
END;
$$ LANGUAGE plpgsql;

-- Function to clean up old data (data retention)
CREATE OR REPLACE FUNCTION cleanup_old_data()
RETURNS INTEGER AS $$
DECLARE
    retention_days INTEGER := COALESCE(NULLIF(current_setting('app.data_retention_days', true), ''), '730')::INTEGER;
    cutoff_date TIMESTAMP WITH TIME ZONE;
    deleted_count INTEGER := 0;
BEGIN
    cutoff_date := NOW() - (retention_days || ' days')::INTERVAL;

    -- Delete old resolved submissions
    DELETE FROM contact_submissions
    WHERE status = 'resolved'
    AND created_at < cutoff_date;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    -- Delete expired session tokens
    DELETE FROM session_tokens WHERE expires_at < NOW();

    -- Delete old rate limit records
    DELETE FROM rate_limits WHERE window_end < NOW() - INTERVAL '7 days';

    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Create view for submission statistics
CREATE VIEW submission_stats AS
SELECT
    COUNT(*) as total_submissions,
    COUNT(CASE WHEN status = 'new' THEN 1 END) as new_submissions,
    COUNT(CASE WHEN status = 'in_progress' THEN 1 END) as in_progress_submissions,
    COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved_submissions,
    COUNT(CASE WHEN status = 'spam' THEN 1 END) as spam_submissions,
    COUNT(CASE WHEN created_at >= CURRENT_DATE THEN 1 END) as submissions_today,
    COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as submissions_this_week,
    COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as submissions_this_month,
    ROUND(AVG(spam_score), 2) as average_spam_score,
    MAX(created_at) as last_submission
FROM contact_submissions;

-- Set default data retention days (can be overridden)
SET app.data_retention_days TO '730';