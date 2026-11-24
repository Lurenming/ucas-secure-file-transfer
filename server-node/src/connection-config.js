import { isIP } from 'node:net';
export function listenConfig(env = process.env) {
  const host = env.SFT_LISTEN_HOST || '127.0.0.1';
  const port = Number(env.SFT_PORT || 8443);
  if (!isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SFT_LISTEN_HOST (IP literal) or SFT_PORT');
  if (!['127.0.0.1', '::1'].includes(host) && env.SFT_ALLOW_LAN !== '1') throw new Error('LAN listening requires explicit SFT_ALLOW_LAN=1');
  return { host, port };
}
export function authMode(value = process.env.SFT_AUTH_MODE || 'password') {
  if (!['password', 'mtls-required'].includes(value)) throw new Error('SFT_AUTH_MODE must be password or mtls-required');
  return value;
}
