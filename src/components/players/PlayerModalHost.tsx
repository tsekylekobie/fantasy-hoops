"use client";

// Opens the player modal from any page: wrap the page in PlayerModalHost and
// make each player a PlayerButton. The Players page drives its own modal from
// the URL instead.
import { createContext, useContext, useState } from "react";
import PlayerModal from "./PlayerModal";
import styles from "./PlayerModalHost.module.css";

const OpenPlayer = createContext<((id: number) => void) | null>(null);

export default function PlayerModalHost({ children }: { children: React.ReactNode }) {
  const [playerId, setPlayerId] = useState<number | null>(null);
  return (
    <OpenPlayer.Provider value={setPlayerId}>
      {children}
      <PlayerModal playerId={playerId} onClose={() => setPlayerId(null)} />
    </OpenPlayer.Provider>
  );
}

/**
 * A player's avatar and name as one button that opens his modal. It lays out
 * its children in a row, with its parent's gap. Mark the name with
 * `data-player-name` to underline it on hover.
 */
export function PlayerButton({ playerId, children }: { playerId: number; children: React.ReactNode }) {
  const open = useContext(OpenPlayer);
  return (
    <button type="button" className={styles.btn} onClick={() => open?.(playerId)}>
      {children}
    </button>
  );
}
