function buildOpeningTurnText(_config, userText) {
  return String(userText || "").trim();
}

function buildInstructionRefreshText() {
  return "Refresh your current behavior from the active character card and current project rules. Reply in one short Chinese sentence confirming that the thread is refreshed.";
}

module.exports = {
  buildOpeningTurnText,
  buildInstructionRefreshText,
};
