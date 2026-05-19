const fs = require("fs");
const path = require("path");

class CharacterStateStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = createEmptyState();
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.state = {
          ...createEmptyState(),
          ...parsed,
          bindings: parsed.bindings && typeof parsed.bindings === "object" ? parsed.bindings : {},
        };
      }
    } catch {
      this.state = createEmptyState();
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getBindingState(bindingKey) {
    const normalized = normalizeValue(bindingKey);
    if (!normalized) {
      return createEmptyBindingState();
    }
    return {
      ...createEmptyBindingState(),
      ...(this.state.bindings[normalized] || {}),
    };
  }

  getActiveCharacterId(bindingKey) {
    return normalizeValue(this.getBindingState(bindingKey).activeCharacterId);
  }

  setActiveCharacterId(bindingKey, characterId) {
    const normalizedBindingKey = normalizeValue(bindingKey);
    const normalizedCharacterId = normalizeValue(characterId);
    if (!normalizedBindingKey || !normalizedCharacterId) {
      return null;
    }
    const current = this.getBindingState(normalizedBindingKey);
    const next = {
      ...current,
      activeCharacterId: normalizedCharacterId,
      updatedAt: new Date().toISOString(),
    };
    this.state.bindings[normalizedBindingKey] = next;
    this.save();
    return { ...next };
  }

  clearActiveCharacterId(bindingKey) {
    const normalizedBindingKey = normalizeValue(bindingKey);
    if (!normalizedBindingKey) {
      return null;
    }
    const current = this.getBindingState(normalizedBindingKey);
    const next = {
      ...current,
      activeCharacterId: "",
      updatedAt: new Date().toISOString(),
    };
    this.state.bindings[normalizedBindingKey] = next;
    this.save();
    return { ...next };
  }

}

function createEmptyState() {
  return {
    bindings: {},
  };
}

function createEmptyBindingState() {
  return {
    activeCharacterId: "",
    updatedAt: "",
  };
}

function buildCharacterBindingKey(bindingKey, characterId) {
  const normalizedBindingKey = normalizeValue(bindingKey);
  const normalizedCharacterId = normalizeValue(characterId);
  if (!normalizedBindingKey || !normalizedCharacterId) {
    return normalizedBindingKey;
  }
  return `${normalizedBindingKey}:character:${normalizedCharacterId}`;
}

function normalizeValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  CharacterStateStore,
  buildCharacterBindingKey,
};
