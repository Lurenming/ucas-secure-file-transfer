import { createHash, randomBytes } from 'node:crypto';
const digest = value => createHash('sha256').update(value).digest('hex');

// The ticket is a short-lived WSS-only delegation credential minted by an authenticated
// control connection, never a username assertion. It expires with that control session.
export class WindowAuth {
  constructor(manager) { this.manager = manager; this.tickets = new Map(); }
  open(auth) {
    if (!auth.snapshot()) throw new Error('AUTH_REQUIRED');
    if (auth.group && auth.group.control !== auth) throw new Error('AUTH_FAILED');
    const group = auth.group ?? { control: auth, members: new Set([auth]), identity: { ...auth.identity } };
    auth.group = group;
    if (group.ticketHash) this.tickets.delete(group.ticketHash);
    const ticket = randomBytes(32).toString('base64url');
    group.ticketHash = digest(ticket); group.ticketDeadline = Math.min(Date.now() + 60000, auth.identity.expiresAt);
    this.tickets.set(group.ticketHash, group);
    return { ticket, expiresAt: new Date(group.ticketDeadline).toISOString(), maxConnections: 8 };
  }
  attach(auth, ticket) {
    if (typeof ticket !== 'string' || !/^[\w-]{43}$/.test(ticket)) throw new Error('AUTH_FAILED');
    const group = this.tickets.get(digest(ticket));
    if (!group || Date.now() >= group.ticketDeadline || !group.control.snapshot() || group.members.size >= 9) throw new Error('AUTH_FAILED');
    if (auth.manager.mode === 'mtls-required' && (!auth.peerFingerprint || auth.peerFingerprint !== group.identity.fingerprint)) throw new Error('AUTH_FAILED');
    auth.group = group; group.members.add(auth);
    return { ...group.identity };
  }
  leave(auth) {
    const group = auth.group; auth.group = null;
    if (!group) return;
    group.members.delete(auth);
    if (group.control === auth) {
      this.tickets.delete(group.ticketHash);
      for (const member of [...group.members]) {
        member.group = null; member.invalidate();
        member.send({ type: 'AUTH_EXPIRED', data: {} });
        member.closeConnection(1008, 'Window session ended');
      }
      group.members.clear();
    }
  }
}
