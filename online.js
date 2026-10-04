// online.js — catan の通信対戦（「みんなのスマホで」）。
// 部屋のしくみ（作る・入る・顔ぶれ・状態の送受信）は room.js（正本は本部の online-kit）。
// ここは catan の待合の形（settings・seats）を組み立てるだけ。画面は main.js が持つ。
import { createRoom, joinRoom, isValidCode, sanitizeName as roomSanitizeName, roomLinkFor, roomCodeFromHash } from './room.js';

const GAME = 'catan';

// 待合の座席。空いている人の席は uid: null。
// [{ type: 'human', uid: string|null, name: string }, { type: 'cpu', level: 'weak'|'normal'|'strong' }, ...]
function emptySeats(count) {
  return Array.from({ length: count }, () => ({ type: 'human', uid: null, name: '' }));
}

function parseSeats(json, count) {
  try {
    const arr = JSON.parse(json || '[]');
    if (Array.isArray(arr) && arr.length) return arr;
  } catch { /* 壊れていたら空の席として扱う */ }
  return emptySeats(count);
}

function parseSettings(json) {
  try { return JSON.parse(json || '{}') || {}; } catch { return {}; }
}

// members（全員）のうち座っていない人を、空いている人の席に座らせる（ホストだけが呼ぶ）
function seatMembers(seats, members) {
  const next = seats.map((s) => ({ ...s }));
  const seated = new Set(next.filter((s) => s.type === 'human' && s.uid).map((s) => s.uid));
  Object.keys(members || {}).forEach((uid) => {
    if (seated.has(uid)) return;
    const open = next.find((s) => s.type === 'human' && !s.uid);
    if (!open) return;
    open.uid = uid;
    open.name = roomSanitizeName((members[uid] && members[uid].name) || '');
    seated.add(uid);
  });
  return next;
}

// 全席が人（座った）かCPUで、人が2人以上なら始められる
function canStart(seats) {
  const humanCount = seats.filter((s) => s.type === 'human').length;
  return humanCount >= 2 && seats.every((s) => s.type === 'cpu' || (s.type === 'human' && s.uid));
}

export {
  createRoom, joinRoom, isValidCode, roomSanitizeName, roomLinkFor, roomCodeFromHash,
  GAME, emptySeats, parseSeats, parseSettings, seatMembers, canStart,
};
