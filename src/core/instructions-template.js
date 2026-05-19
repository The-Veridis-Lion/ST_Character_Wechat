function resolveUserDisplayName(userName, { random = Math.random } = {}) {
  const choices = splitUserDisplayNameChoices(userName);
  if (choices.length <= 1) {
    return choices[0] || "用户";
  }
  const value = typeof random === "function" ? Number(random()) : Math.random();
  const ratio = Number.isFinite(value) ? Math.max(0, Math.min(0.999999, value)) : Math.random();
  return choices[Math.floor(ratio * choices.length)] || choices[0] || "用户";
}

function splitUserDisplayNameChoices(userName) {
  return String(userName || "")
    .split(/\s*(?:[\/／|、]|\r?\n)\s*/u)
    .map((choice) => choice.trim())
    .filter(Boolean);
}

function resolveUserPronoun(gender) {
  const normalized = String(gender || "").trim().toLowerCase();
  if (normalized === "male" || normalized === "man" || normalized === "m" || normalized === "男") {
    return "他";
  }
  if (normalized === "neutral" || normalized === "nonbinary" || normalized === "nb" || normalized === "ta") {
    return "TA";
  }
  return "她";
}

function renderInstructionTemplate(template, config = {}) {
  const userName = resolveUserDisplayName(config?.userName);
  const pronoun = resolveUserPronoun(config?.userGender);
  return String(template || "")
    .replaceAll("{{USER_NAME}}", userName)
    .replaceAll("她", pronoun);
}

module.exports = {
  resolveUserDisplayName,
  renderInstructionTemplate,
  resolveUserPronoun,
};
