// ─── 🃏 POKER SUITE DISPATCHER & RE-EXPORT HUB ───────────────────
import { handleTexasHoldem, activeTexasGames } from './texasHoldem.js';
import { handleCapsaSusun, activeCapsaGames } from './capsaSusun.js';
import { handleFastPoker, activeFastPokerGames } from './fastPoker.js';

export { activeTexasGames, activeCapsaGames, activeFastPokerGames };

export async function handlePokerCommand(sock, jid, senderNumber, messageObj, args, command, isFromGroup) {
  // Texas Hold'em
  if (['poker', 'texaspoker', 'texas', 'holdem', 'joinpoker', 'startpoker', 'batalpoker', 'check', 'call', 'raise', 'allin', 'fold', 'kartu', 'hand', 'mycards', 'cekkartu', 'kartuku'].includes(command)) {
    return await handleTexasHoldem(sock, jid, senderNumber, messageObj, args, command, isFromGroup);
  }

  // Capsa Susun
  if (['capsa', 'capsasusun', 'joincapsa', 'startcapsa', 'batalcapsa'].includes(command)) {
    return await handleCapsaSusun(sock, jid, senderNumber, messageObj, args, command, isFromGroup);
  }

  // Fast 3-Card Poker
  if (['fastpoker', 'poker3', 'joinfastpoker', 'startfastpoker', 'batalfastpoker'].includes(command)) {
    return await handleFastPoker(sock, jid, senderNumber, messageObj, args, command, isFromGroup);
  }

  return false;
}
