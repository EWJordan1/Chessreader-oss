/*
 * The grammar (§8): how a move is said. Every level returns a sentence — capitalised,
 * tail clauses set off by commas, ending in a full stop — because punctuation is the
 * only prosody a voice has. Without it "knight to c6" comes out as "note c6"; that
 * slur is also why the preposition appears only between two squares and never straight
 * after a piece name.
 */
const PIECE = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const COLOR = { w: 'White', b: 'Black' };

function sentence(s) {
  s = s.trim().replace(/\s+,/g, ',').replace(/\s+/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

function tail(move) {
  const t = [];
  if ((move.flags || '').includes('e')) t.push('en passant');
  if (move.promotion) t.push('promoting to ' + PIECE[move.promotion]);
  if (/#$/.test(move.san)) t.push('checkmate');
  else if (/\+$/.test(move.san)) t.push('check');
  return t.length ? ', ' + t.join(', ') : '';
}

/**
 * @param move  a chess.js verbose move
 * @param verbosity 'full' | 'natural' | 'short'
 */
export function moveToSpeech(move, verbosity = 'full') {
  if (!move) return '';
  const san = move.san || '';
  if (verbosity === 'short') return sentence(san.replace(/[+#]$/, '')) .replace(/\.$/, tail(move) ? tail(move).slice(2) === 'check' ? ', check.' : (tail(move).slice(2) === 'checkmate' ? ', checkmate.' : '.') : '.');
  const flags = move.flags || '';
  const piece = PIECE[move.piece] || 'piece';
  if (flags.includes('k') || flags.includes('q')) {
    const side = flags.includes('k') ? 'kingside' : 'queenside';
    return sentence((verbosity === 'full' ? COLOR[move.color] + ' castles ' : 'castles ') + side + tail(move));
  }
  const captures = !!move.captured || flags.includes('e');
  // Disambiguated notation (Nbd7, R1e2) names the whole origin square: a bare
  // "knight b d7" is not speech.
  const disambig = /^[NBRQK][a-h1-8][a-h]?[1-8]?x?[a-h][1-8]/.test(san) && san.length > 3 && !/^[NBRQK]x?[a-h][1-8]/.test(san);
  if (verbosity === 'full') {
    return sentence(COLOR[move.color] + ' ' + piece + ' from ' + move.from + ' to ' + move.to +
      (captures ? ', takes ' + (PIECE[move.captured] || 'pawn') : '') + tail(move));
  }
  // natural — how a commentator says it
  let body;
  if (move.piece === 'p') {
    body = captures ? 'pawn takes ' + move.to : 'pawn ' + move.to;
  } else if (disambig) {
    body = piece + ' from ' + move.from + (captures ? ' takes ' : ' to ') + move.to;
  } else {
    body = piece + (captures ? ' takes ' : ' ') + move.to;
  }
  return sentence(body + tail(move));
}

/** "White wins by resignation." / "Draw by agreement." off the Result and Termination headers. */
export function resultSpeech(headers) {
  const r = headers.Result || '';
  const term = (headers.Termination || '').toLowerCase();
  let how = '';
  if (/resign/.test(term)) how = 'by resignation';
  else if (/checkmate|mate/.test(term)) how = 'by checkmate';
  else if (/time|clock|forfeit/.test(term)) how = 'on time';
  else if (/abandon/.test(term)) how = 'by abandonment';
  else if (/stalemate/.test(term)) how = 'by stalemate';
  else if (/repetition/.test(term)) how = 'by repetition';
  else if (/insufficient/.test(term)) how = 'by insufficient material';
  else if (/agreement/.test(term)) how = 'by agreement';
  else if (/50|fifty/.test(term)) how = 'by the fifty-move rule';
  const who = r === '1-0' ? 'White wins' : r === '0-1' ? 'Black wins' : r === '1/2-1/2' ? 'Draw' : '';
  if (!who) return '';
  return sentence(who + (how ? ' ' + how : ''));
}

/** The time control as a phrase: "3 minute blitz", "10 plus 5 rapid", or ''. */
export function timeControlPhrase(headers) {
  const tc = headers.TimeControl || '';
  const m = /^(\d+)(?:\+(\d+))?$/.exec(tc);
  if (!m) return '';
  const base = +m[1], inc = +(m[2] || 0);
  const mins = Math.round(base / 60);
  const cls = base + inc * 40 < 180 ? 'bullet' : base + inc * 40 < 600 ? 'blitz' : base + inc * 40 < 1800 ? 'rapid' : 'classical';
  return (mins ? mins + ' minute' : base + ' second') + (inc ? ' plus ' + inc : '') + ' ' + cls;
}

/** The game announcement, gated by S.announce at the call site. */
export function announcementSpeech(headers) {
  const w = headers.White && headers.White !== '?' ? headers.White : 'White';
  const b = headers.Black && headers.Black !== '?' ? headers.Black : 'Black';
  const tc = timeControlPhrase(headers);
  return sentence(w + ' against ' + b + (tc ? ', ' + tc : ''));
}

/*
 * The opening announcement lands mid-game (§8): Chess.com's ECOUrl holds the name and
 * the line that identifies it, so the name is spoken at the ply where the line ends,
 * hung off that move in one breath. Returns {ply, clause} or null; the clause is
 * appended to the move sentence at that ply. A Lichess `Opening` header carries no line,
 * so it falls to ply 0 and stands alone.
 */
export function openingAnnouncement(headers) {
  const url = headers.ECOUrl || '';
  const m = /openings\/([^/?#]+)/.exec(url);
  if (m) {
    const parts = m[1].split('-');
    // The name is every token up to the first move number; the line is the rest.
    // "2.exd5" is White's second move (ply 3); a bare token after it is Black's reply.
    let i = 0;
    while (i < parts.length && !/^\d+\.{1,3}/.test(parts[i])) i++;
    const name = parts.slice(0, i).join(' ').trim();
    if (!name) return null;
    let ply = 0;
    for (const tok of parts.slice(i)) {
      const mm = /^(\d+)(\.{1,3})(.*)$/.exec(tok);
      if (mm) { ply = (+mm[1] - 1) * 2 + (mm[2].length === 3 ? 2 : 1); if (!mm[3]) ply--; }
      else ply++;
    }
    return { ply, clause: ', the ' + name };
  }
  const op = headers.Opening;
  if (op && op !== '?') return { ply: 0, clause: sentence('The ' + op.replace(/:\s*/g, ', ')) };
  return null;
}

/*
 * A position the way a player dictates one: two sentences, a side each, king first and
 * pawns last — not thirty per-piece utterances.
 */
export function positionSpeech(fen) {
  const rows = String(fen).split(' ')[0].split('/');
  const side = { w: {}, b: {} };
  const ORDER = ['k', 'q', 'r', 'b', 'n', 'p'];
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') { f += +ch; continue; }
      const sq = String.fromCharCode(97 + f) + (8 - r);
      const c = ch === ch.toUpperCase() ? 'w' : 'b';
      const p = ch.toLowerCase();
      (side[c][p] = side[c][p] || []).push(sq);
      f++;
    }
  }
  const say = c => {
    const parts = [];
    for (const p of ORDER) {
      const sqs = side[c][p];
      if (!sqs) continue;
      const name = PIECE[p] + (sqs.length > 1 ? 's' : '');
      parts.push(name + ' on ' + sqs.join(', '));
    }
    return sentence(COLOR[c] + ': ' + parts.join('; '));
  };
  const toMove = String(fen).split(' ')[1] === 'b' ? 'Black' : 'White';
  return say('w') + ' ' + say('b') + ' ' + sentence(toMove + ' to move');
}
