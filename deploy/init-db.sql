-- ADMP Database Schema v1.0
-- Agent Dispatch Messaging Protocol - PostgreSQL initialization

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Agents table - registered agents in the system
CREATE TABLE IF NOT EXISTS agent (
  id VARCHAR(255) PRIMARY KEY,
  display_name VARCHAR(255),
  public_key TEXT,
  key_algorithm VARCHAR(50) DEFAULT 'ed25519',
  api_key_hash TEXT,
  capabilities JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agent_updated_at ON agent(updated_at);

-- Messages table - core inbox storage
CREATE TABLE IF NOT EXISTS message (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Envelope fields
  version VARCHAR(10) DEFAULT '1.0',
  type VARCHAR(100) NOT NULL,
  from_agent VARCHAR(255) NOT NULL,
  to_agent_id VARCHAR(255) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  correlation_id VARCHAR(255),

  -- Content
  body JSONB NOT NULL DEFAULT '{}',
  headers JSONB DEFAULT '{}',

  -- Metadata
  channel VARCHAR(20) NOT NULL DEFAULT 'http', -- 'http' or 'smtp'
  status VARCHAR(20) NOT NULL DEFAULT 'queued', -- queued, sent, delivered, leased, acked, nacked, failed, dead

  -- Delivery tracking
  idempotency_key VARCHAR(255),
  source_fingerprint VARCHAR(64),
  ttl_sec INTEGER DEFAULT 86400,

  -- Timestamps
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  leased_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  acked_at TIMESTAMPTZ,

  -- Processing
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  last_error TEXT,

  -- Reply tracking
  reply JSONB,

  -- Signature
  signature_alg VARCHAR(50),
  signature_kid VARCHAR(255),
  signature_sig TEXT,

  -- Audit
  delivery_log JSONB DEFAULT '[]'
);

-- Indexes for performance
CREATE INDEX idx_message_to_agent_status ON message(to_agent_id, status);
CREATE INDEX idx_message_status ON message(status);
CREATE INDEX idx_message_correlation_id ON message(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_message_idempotency ON message(to_agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_message_fingerprint ON message(to_agent_id, source_fingerprint, created_at) WHERE source_fingerprint IS NOT NULL;
CREATE INDEX idx_message_lease_expiry ON message(lease_until) WHERE status = 'leased';
CREATE INDEX idx_message_ttl ON message(timestamp, ttl_sec) WHERE status IN ('queued', 'delivered', 'leased');
CREATE INDEX idx_message_created_at ON message(created_at);

-- Policies table - authorization rules
CREATE TABLE IF NOT EXISTS policy (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  enabled BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 100,

  -- Matching rules
  from_agent_pattern VARCHAR(255),
  to_agent_pattern VARCHAR(255),
  type_pattern VARCHAR(255),
  subject_pattern VARCHAR(255),

  -- Constraints
  max_size_kb INTEGER,
  rate_limit_per_hour INTEGER,

  -- Action
  action VARCHAR(20) DEFAULT 'allow', -- 'allow' or 'deny'

  -- Metadata
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_policy_enabled ON policy(enabled, priority);

-- Agent keys table - for key rotation
CREATE TABLE IF NOT EXISTS agent_key (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id VARCHAR(255) NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  kid VARCHAR(255) NOT NULL UNIQUE,
  algorithm VARCHAR(50) NOT NULL DEFAULT 'ed25519',
  public_key TEXT NOT NULL,
  private_key_encrypted TEXT, -- encrypted with master key, optional
  active BOOLEAN DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agent_key_kid ON agent_key(kid);
CREATE INDEX idx_agent_key_agent_active ON agent_key(agent_id, active);

-- Audit log table - comprehensive event tracking
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  timestamp TIMESTAMPTZ DEFAULT NOW(),

  -- Event details
  event_type VARCHAR(100) NOT NULL,
  message_id UUID REFERENCES message(id) ON DELETE SET NULL,
  agent_id VARCHAR(255),

  -- Context
  channel VARCHAR(20),
  status_from VARCHAR(20),
  status_to VARCHAR(20),

  -- Additional data
  metadata JSONB DEFAULT '{}',
  error_message TEXT
);

CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_log_message_id ON audit_log(message_id);
CREATE INDEX idx_audit_log_agent_id ON audit_log(agent_id);
CREATE INDEX idx_audit_log_event_type ON audit_log(event_type);

-- Function to automatically update updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_agent_updated_at BEFORE UPDATE ON agent
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_policy_updated_at BEFORE UPDATE ON policy
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to reclaim expired leases
CREATE OR REPLACE FUNCTION reclaim_expired_leases()
RETURNS INTEGER AS $$
DECLARE
  reclaimed_count INTEGER;
BEGIN
  UPDATE message
  SET status = 'delivered',
      leased_at = NULL,
      lease_until = NULL,
      attempts = attempts + 1
  WHERE status = 'leased'
    AND lease_until < NOW()
    AND attempts < max_attempts;

  GET DIAGNOSTICS reclaimed_count = ROW_COUNT;

  -- Mark as dead if max attempts reached
  UPDATE message
  SET status = 'dead',
      last_error = 'Max lease attempts exceeded'
  WHERE status = 'leased'
    AND lease_until < NOW()
    AND attempts >= max_attempts;

  RETURN reclaimed_count;
END;
$$ LANGUAGE plpgsql;

-- Function to expire TTL messages
CREATE OR REPLACE FUNCTION expire_ttl_messages()
RETURNS INTEGER AS $$
DECLARE
  expired_count INTEGER;
BEGIN
  UPDATE message
  SET status = 'dead',
      last_error = 'TTL expired'
  WHERE status IN ('queued', 'delivered', 'leased')
    AND (EXTRACT(EPOCH FROM (NOW() - timestamp)) > ttl_sec);

  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$ LANGUAGE plpgsql;

-- Insert default policy (allow all for development)
INSERT INTO policy (name, description, from_agent_pattern, to_agent_pattern, action, priority)
VALUES ('default-allow-all', 'Default policy - allow all messages (development only)', '.*', '.*', 'allow', 999)
ON CONFLICT DO NOTHING;

-- Create a sample agent for testing
INSERT INTO agent (id, display_name, capabilities)
VALUES ('test-agent', 'Test Agent', '["send", "receive"]')
ON CONFLICT DO NOTHING;

-- Grant permissions
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO admp;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO admp;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO admp;

-- Success message
DO $$
BEGIN
  RAISE NOTICE 'ADMP database schema initialized successfully!';
  RAISE NOTICE 'Tables created: agent, message, policy, agent_key, audit_log';
  RAISE NOTICE 'Functions created: reclaim_expired_leases(), expire_ttl_messages()';
END $$;
