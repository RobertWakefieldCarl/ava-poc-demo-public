'use strict';

/**
 * Secret storage backed by whatever the operating system already provides, so no API key ever
 * lands in the skill folder, a dotfile, a recording, or shell history.
 *
 *   Windows  DPAPI (CurrentUser scope) — the ciphertext is only readable by this Windows account,
 *            stored under %LOCALAPPDATA%. There is no dependency-free way to read a Credential
 *            Manager password back out, so DPAPI is the practical equivalent.
 *   macOS    Keychain via `security`
 *   Linux    libsecret via `secret-tool`, falling back to a 0600 file when it is absent
 *
 * The skill directory is deliberately never written to: skills get copied, synced and shared.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const SERVICE = 'ava-poc-demo';

function storeDir() {
  const base =
    process.env.LOCALAPPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
  return path.join(base, SERVICE);
}

const storeFile = () => path.join(storeDir(), 'credentials.json');

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(data) {
  fs.mkdirSync(storeDir(), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify(data, null, 2), { mode: 0o600 });
  // mkdir/writeFile modes are advisory on Windows; chmod is a no-op there but matters on POSIX.
  try {
    fs.chmodSync(storeFile(), 0o600);
  } catch {
    /* not supported on this filesystem */
  }
}

// ------------------------------------------------------------------- Windows

// Secrets go in and out over stdin so they never appear in a command line or the process list.
const PS_PROTECT = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$plain=[Console]::In.ReadToEnd()
$b=[Text.Encoding]::UTF8.GetBytes($plain)
$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($p))
`;

const PS_UNPROTECT = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$b64=[Console]::In.ReadToEnd().Trim()
$p=[Convert]::FromBase64String($b64)
$b=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))
`;

function ps(script, input) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error((r.stderr || 'powershell failed').trim().split('\n')[0]);
  return r.stdout;
}

// --------------------------------------------------------------- macOS/Linux

function mac(args, input) {
  return spawnSync('security', args, { input, encoding: 'utf8' });
}

function hasSecretTool() {
  return spawnSync('secret-tool', ['--version'], { stdio: 'ignore' }).status === 0;
}

// ---------------------------------------------------------------- public API

export function backendName() {
  if (process.platform === 'win32') return 'Windows DPAPI (current user)';
  if (process.platform === 'darwin') return 'macOS Keychain';
  return hasSecretTool() ? 'libsecret (secret-tool)' : 'file with 0600 permissions';
}

export function setSecret(name, value) {
  if (!value || !value.trim()) throw new Error('refusing to store an empty secret');
  const secret = value.trim();

  if (process.platform === 'win32') {
    const store = readStore();
    store[name] = ps(PS_PROTECT, secret);
    writeStore(store);
    return;
  }

  if (process.platform === 'darwin') {
    const r = mac(['add-generic-password', '-s', SERVICE, '-a', name, '-w', secret, '-U']);
    if (r.status !== 0) throw new Error((r.stderr || 'security failed').trim());
    return;
  }

  if (hasSecretTool()) {
    const r = spawnSync(
      'secret-tool',
      ['store', '--label', `${SERVICE} ${name}`, 'service', SERVICE, 'account', name],
      { input: secret, encoding: 'utf8' }
    );
    if (r.status !== 0) throw new Error((r.stderr || 'secret-tool failed').trim());
    return;
  }

  const store = readStore();
  store[name] = Buffer.from(secret, 'utf8').toString('base64');
  writeStore(store);
}

/** Returns the secret, or null when it was never stored. Never throws on absence. */
export function getSecret(name) {
  try {
    if (process.platform === 'win32') {
      const blob = readStore()[name];
      return blob ? ps(PS_UNPROTECT, blob) || null : null;
    }

    if (process.platform === 'darwin') {
      const r = mac(['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
      return r.status === 0 ? r.stdout.trim() || null : null;
    }

    if (hasSecretTool()) {
      const r = spawnSync('secret-tool', ['lookup', 'service', SERVICE, 'account', name], {
        encoding: 'utf8',
      });
      return r.status === 0 ? r.stdout.trim() || null : null;
    }

    const blob = readStore()[name];
    return blob ? Buffer.from(blob, 'base64').toString('utf8') : null;
  } catch {
    // A secret that cannot be decrypted (copied profile, different user) is treated as absent
    // so callers fall through to the environment variable rather than crashing.
    return null;
  }
}

export function clearSecret(name) {
  if (process.platform === 'darwin') {
    mac(['delete-generic-password', '-s', SERVICE, '-a', name]);
    return;
  }
  if (process.platform !== 'win32' && hasSecretTool()) {
    spawnSync('secret-tool', ['clear', 'service', SERVICE, 'account', name], { stdio: 'ignore' });
    return;
  }
  const store = readStore();
  delete store[name];
  writeStore(store);
}

/**
 * The resolution order every script should use: an explicit environment variable wins so CI and
 * one-off overrides keep working, then the OS keystore.
 */
export function resolveSecret(name, envVar) {
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.trim()) return { value: fromEnv.trim(), source: envVar };
  const stored = getSecret(name);
  return stored ? { value: stored, source: backendName() } : { value: null, source: null };
}

// ------------------------------------------------- sealed keys for distribution

/**
 * A shared team key committed to a repo must never be committed in the clear: git history is
 * permanent, so a key that lands in one commit stays recoverable in every clone forever, even
 * after it is "removed". Sealing encrypts it under a passphrase that travels out of band, so
 * the repo alone is not enough to use the key.
 *
 * scrypt with these parameters costs roughly 100 ms and 32 MB per attempt, which makes brute
 * forcing a decent passphrase impractical. AES-256-GCM detects tampering with the sealed file.
 */
const KDF = { N: 2 ** 15, r: 8, p: 1, keyLen: 32 };

const derive = (passphrase, salt) =>
  crypto.scryptSync(passphrase.normalize('NFKC'), salt, KDF.keyLen, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: 256 * 1024 * 1024,
  });

export function seal(plaintext, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derive(passphrase, salt), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    cipher: 'aes-256-gcm',
    kdf: { name: 'scrypt', ...KDF },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
    // A fingerprint of the plaintext, so `status` can tell which key is sealed without
    // decrypting it, and so a rotation is visible in the diff.
    fingerprint: crypto.createHash('sha256').update(plaintext).digest('hex').slice(0, 12),
    sealedAt: new Date().toISOString(),
  };
}

export function unseal(sealed, passphrase) {
  if (!sealed || sealed.v !== 1) throw new Error('unrecognised sealed-key format');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    derive(passphrase, Buffer.from(sealed.salt, 'base64')),
    Buffer.from(sealed.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM cannot distinguish a wrong passphrase from a corrupted file.
    throw new Error('wrong passphrase, or the sealed file has been modified');
  }
}
