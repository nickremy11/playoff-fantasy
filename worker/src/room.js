/**
 * PlayoffRoom — Cloudflare Durable Object
 *
 * One instance per playoff fantasy league, keyed by roomId.
 * Manages room state, WebSocket connections, and snake draft logic.
 *
 * Roster limits per team: QB×2, RB×3, WR×3, TE×2 (10 total).
 * One NFL team per fantasy team — can't draft two players from the same NFL team.
 *
 * HTTP routes:
 *   POST /init                            → initialize room state
 *   GET  /api/playoff/rooms/:id           → return public state
 *   DELETE /api/playoff/rooms/:id         → delete room (commissioner only)
 *   POST /api/playoff/rooms/:id/claim     → claim a team slot, get sessionToken
 *   POST /api/playoff/rooms/:id/undo      → undo last pick (commissioner only)
 *   GET  /api/playoff/rooms/:id/ws        → WebSocket for live draft
 */

export class PlayoffRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // sessionId -> WebSocket
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/init' && request.method === 'POST') {
      const room = await request.json();
      await this.state.storage.put('room', room);
      await this.state.storage.setAlarm(room.expiresAt);
      return ok({ ok: true });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    const parts = url.pathname.split('/').filter(Boolean);
    // /api/playoff/rooms/:id        → parts[3] = id, parts[4] = undefined
    // /api/playoff/rooms/:id/claim  → parts[4] = 'claim'
    const action = parts[4] || '';

    if (!action) {
      if (request.method === 'GET') return this.getState();
      if (request.method === 'DELETE') return this.deleteRoom(request);
    }
    if (action === 'claim' && request.method === 'POST') return this.claimSlot(request);
    if (action === 'undo'  && request.method === 'POST') return this.undoPick(request);

    return new Response('Not found', { status: 404 });
  }

  // ── State ──────────────────────────────────────────────────────────────────

  async getState() {
    const room = await this.state.storage.get('room');
    if (!room) return new Response('Room not found', { status: 404 });
    return ok(this.publicState(room));
  }

  async deleteRoom(request) {
    const { commissionerCode } = await request.json().catch(() => ({}));
    const room = await this.state.storage.get('room');
    if (!room) return new Response('Room not found', { status: 404 });
    if (room.commissionerCode !== commissionerCode) {
      return new Response('Unauthorized', { status: 401 });
    }
    for (const ws of this.sessions.values()) {
      try { ws.close(1000, 'Room deleted'); } catch {}
    }
    this.sessions.clear();
    await this.state.storage.deleteAll();
    return ok({ ok: true });
  }

  async claimSlot(request) {
    const { claimCode } = await request.json().catch(() => ({}));
    const room = await this.state.storage.get('room');
    if (!room) return new Response('Room not found', { status: 404 });

    const slot = room.teamSlots.find(s => s.claimCode === claimCode?.toUpperCase());
    if (!slot) return new Response('Invalid claim code', { status: 403 });

    if (slot.sessionToken) {
      return ok({ sessionToken: slot.sessionToken, slotIndex: slot.index, slotName: slot.name });
    }

    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

    slot.sessionToken = token;
    slot.claimed = true;
    await this.state.storage.put('room', room);
    this.broadcast({ type: 'state', room: this.publicState(room) });

    return ok({ sessionToken: token, slotIndex: slot.index, slotName: slot.name });
  }

  async undoPick(request) {
    const { commissionerCode } = await request.json().catch(() => ({}));
    const room = await this.state.storage.get('room');
    if (!room) return new Response('Room not found', { status: 404 });
    if (room.commissionerCode !== commissionerCode) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (!room.picks.length) return new Response('No picks to undo', { status: 400 });

    const last = room.picks.pop();
    const asset = room.assets.find(a => a.id === last.assetId);
    if (asset) asset.pickedBy = null;
    room.currentOverallPick = last.overallPick;
    if (room.status === 'complete') room.status = 'active';

    await this.state.storage.put('room', room);
    this.broadcast({ type: 'state', room: this.publicState(room) });
    return ok({ ok: true });
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  async handleWebSocket(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const sid = Math.random().toString(36).slice(2);
    this.sessions.set(sid, server);

    const room = await this.state.storage.get('room');
    if (!room) {
      server.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
      server.close(1008, 'Room not found');
    } else {
      server.send(JSON.stringify({ type: 'state', room: this.publicState(room) }));
    }

    server.addEventListener('message', async evt => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'pick') await this.processPick(msg.assetId, msg.sessionToken, server);
      } catch {}
    });

    server.addEventListener('close', () => this.sessions.delete(sid));
    server.addEventListener('error', () => this.sessions.delete(sid));

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Draft Logic ────────────────────────────────────────────────────────────

  async processPick(assetId, sessionToken, senderWs) {
    const room = await this.state.storage.get('room');
    if (!room || room.status === 'complete') return;

    const slot = room.teamSlots.find(s => s.sessionToken === sessionToken);
    if (!slot) {
      senderWs?.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
      return;
    }

    const expectedSlot = snakeSlot(room.currentOverallPick, room.numTeams, room.draftOrder);
    if (slot.index !== expectedSlot) {
      senderWs?.send(JSON.stringify({ type: 'error', message: 'Not your turn' }));
      return;
    }

    const asset = room.assets.find(a => a.id === assetId && a.pickedBy === null);
    if (!asset) {
      senderWs?.send(JSON.stringify({ type: 'error', message: 'Player not available' }));
      return;
    }

    // Position limit check
    const myPicks = room.assets.filter(a => a.pickedBy === slot.index);
    const posCount = myPicks.filter(a => a.position === asset.position).length;
    if (posCount >= (POS_LIMITS[asset.position] ?? 99)) {
      senderWs?.send(JSON.stringify({ type: 'error', message: `Position limit reached for ${asset.position}` }));
      return;
    }

    // NFL team uniqueness check
    const myNflTeams = new Set(myPicks.map(a => a.nflTeam).filter(Boolean));
    if (asset.nflTeam && myNflTeams.has(asset.nflTeam)) {
      senderWs?.send(JSON.stringify({ type: 'error', message: `Already have a player from ${asset.nflTeam}` }));
      return;
    }

    asset.pickedBy = slot.index;
    const pick0 = room.currentOverallPick - 1;
    room.picks.push({
      overallPick: room.currentOverallPick,
      round: Math.floor(pick0 / room.numTeams) + 1,
      pickInRound: (pick0 % room.numTeams) + 1,
      slotIndex: slot.index,
      assetId,
      timestamp: Date.now(),
    });
    room.currentOverallPick++;

    // Draft ends when every team has 10 players (numTeams * 10 total picks)
    if (room.picks.length >= room.numTeams * PICKS_PER_TEAM) {
      room.status = 'complete';
    }

    await this.state.storage.put('room', room);
    this.broadcast({ type: 'state', room: this.publicState(room) });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  publicState(room) {
    return {
      ...room,
      commissionerCode: undefined,
      teamSlots: room.teamSlots.map(({ claimCode, sessionToken, ...rest }) => rest),
    };
  }

  broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const [sid, ws] of this.sessions) {
      try { ws.send(text); } catch { this.sessions.delete(sid); }
    }
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PICKS_PER_TEAM = 10; // 2 QB + 3 RB + 3 WR + 2 TE
const POS_LIMITS = { QB: 2, RB: 3, WR: 3, TE: 2 };

// ── Pure helpers ──────────────────────────────────────────────────────────────

function snakeSlot(overallPick, numTeams, draftOrder) {
  const pick0 = overallPick - 1;
  const round = Math.floor(pick0 / numTeams);
  const pos   = pick0 % numTeams;
  const idx   = round % 2 === 0 ? pos : (numTeams - 1 - pos);
  return draftOrder[idx];
}

function ok(body) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}
