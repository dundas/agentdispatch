/**
 * Discovery routes
 * Public key directory and per-agent DID documents
 */

import express from 'express';
import { storage } from '../storage/index.js';
import { fromBase64 } from '../utils/crypto.js';

const router = express.Router();

/**
 * Encode bytes as base58btc (Bitcoin alphabet)
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function base58btcEncode(bytes) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = 58n;

  // Count leading zeros
  let leadingZeros = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    leadingZeros++;
  }

  // Convert to BigInt
  let num = 0n;
  for (const byte of bytes) {
    num = num * 256n + BigInt(byte);
  }

  // Encode
  let encoded = '';
  while (num > 0n) {
    const remainder = num % BASE;
    num = num / BASE;
    encoded = ALPHABET[Number(remainder)] + encoded;
  }

  // Add leading '1's for each leading zero byte
  return '1'.repeat(leadingZeros) + encoded;
}

/**
 * Convert a base64 public key to publicKeyMultibase format
 * Ed25519 multicodec prefix: 0xed 0x01, then base58btc with 'z' prefix
 * @param {string} base64PubKey
 * @returns {string}
 */
function toPublicKeyMultibase(base64PubKey) {
  const pubKeyBytes = fromBase64(base64PubKey);
  // Prepend Ed25519 multicodec varint prefix (0xed, 0x01)
  const multicodec = new Uint8Array(2 + pubKeyBytes.length);
  multicodec[0] = 0xed;
  multicodec[1] = 0x01;
  multicodec.set(pubKeyBytes, 2);
  return 'z' + base58btcEncode(multicodec);
}

/**
 * GET /.well-known/agent-keys.json
 * JWKS-style public key directory for all registered agents
 */
router.get('/.well-known/agent-keys.json', async (req, res) => {
  try {
    const agents = await storage.listAgents();

    const keys = agents.map(agent => ({
      kid: agent.agent_id,
      did: agent.did || null,
      kty: 'OKP',
      crv: 'Ed25519',
      x: agent.public_key,
      verification_tier: agent.verification_tier || 'unverified',
      key_version: agent.key_version || 1
    }));

    res.json({ keys });
  } catch (error) {
    res.status(500).json({
      error: 'DISCOVERY_FAILED',
      message: error.message
    });
  }
});

/**
 * GET /api/agents/:agentId/did.json
 * W3C DID document for a specific agent
 */
router.get('/api/agents/:agentId/did.json', async (req, res) => {
  try {
    const agent = await storage.getAgent(req.params.agentId);

    if (!agent) {
      return res.status(404).json({
        error: 'AGENT_NOT_FOUND',
        message: `Agent ${req.params.agentId} not found`
      });
    }

    const did = agent.did || `did:seed:${req.params.agentId}`;

    const didDocument = {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/ed25519-2020/v1'
      ],
      id: did,
      verificationMethod: [
        {
          id: `${did}#key-1`,
          type: 'Ed25519VerificationKey2020',
          controller: did,
          publicKeyMultibase: toPublicKeyMultibase(agent.public_key)
        }
      ],
      authentication: [`${did}#key-1`],
      assertionMethod: [`${did}#key-1`],
      service: [
        {
          id: `${did}#admp-inbox`,
          type: 'ADMPInbox',
          serviceEndpoint: `/api/agents/${agent.agent_id}/messages`
        }
      ]
    };

    // Include all active public keys if agent has multiple (rotation)
    if (agent.public_keys && agent.public_keys.length > 1) {
      didDocument.verificationMethod = agent.public_keys
        .filter(k => k.active || (k.deactivate_at && k.deactivate_at > Date.now()))
        .map((k, i) => ({
          id: `${did}#key-${k.version || i + 1}`,
          type: 'Ed25519VerificationKey2020',
          controller: did,
          publicKeyMultibase: toPublicKeyMultibase(k.public_key)
        }));
      didDocument.authentication = didDocument.verificationMethod.map(vm => vm.id);
      didDocument.assertionMethod = didDocument.verificationMethod.map(vm => vm.id);
    }

    res.json(didDocument);
  } catch (error) {
    res.status(500).json({
      error: 'DID_DOCUMENT_FAILED',
      message: error.message
    });
  }
});

export default router;
