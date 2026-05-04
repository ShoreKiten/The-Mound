/** @file Storage abstraction — wraps save-manager for localStorage persistence with encryption support. */

import { SAVE_KEY, saveGame, loadGame, clearSave } from "./save-manager.js";

export { SAVE_KEY, saveGame, loadGame };

export function resetGame() {
  clearSave();
  location.reload();
}
