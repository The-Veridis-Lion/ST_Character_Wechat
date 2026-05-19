function extractThreadId(response) {
  return normalizeIdentifier(
    response?.result?.thread?.id
    || response?.result?.thread?.threadId
    || response?.result?.thread?.thread_id
    || response?.result?.threadId
    || response?.result?.thread_id
  ) || null;
}

function extractTurnId(response) {
  return normalizeIdentifier(
    response?.result?.turn?.id
    || response?.result?.turn?.turnId
    || response?.result?.turn?.turn_id
    || response?.result?.turnId
    || response?.result?.turn_id
    || response?.result?.id
  );
}

function extractThreadIdFromParams(params) {
  return normalizeIdentifier(
    params?.threadId
    || params?.thread_id
    || params?.thread?.id
    || params?.thread?.threadId
    || params?.thread?.thread_id
  );
}

function extractTurnIdFromParams(params) {
  return normalizeIdentifier(
    params?.turnId
    || params?.turn_id
    || params?.turn?.id
    || params?.turn?.turnId
    || params?.turn?.turn_id
  );
}

function extractItemIdFromParams(params) {
  return normalizeIdentifier(
    params?.itemId
    || params?.item_id
    || params?.item?.id
  );
}

function isAssistantItemType(value) {
  const normalized = normalizeIdentifier(value).replace(/[_-]/g, "").toLowerCase();
  return normalized === "agentmessage" || normalized === "assistantmessage";
}

function isAssistantItemCompleted(message) {
  return message?.method === "item/completed"
    && isAssistantItemType(resolveItemTypeFromParams(message?.params));
}

function extractAssistantText(params) {
  const directText = [
    params?.delta,
    params?.text,
    params?.outputText,
    params?.output_text,
    params?.item?.text,
    params?.item?.outputText,
    params?.item?.output_text,
  ];
  for (const value of directText) {
    if (typeof value === "string" && value.length > 0) {
      return normalizeLineEndings(value);
    }
  }

  const contentObjects = [
    params?.item?.content,
    params?.item?.contents,
    params?.content,
    params?.contents,
    params?.item?.message?.content,
    params?.item?.message?.contents,
  ];
  for (const content of contentObjects) {
    const extracted = extractRawTextFromContent(content);
    if (extracted) {
      return extracted;
    }
  }

  return "";
}

function extractTurnCompletionText(params) {
  const directText = [
    params?.text,
    params?.outputText,
    params?.output_text,
    params?.result?.text,
    params?.result?.outputText,
    params?.result?.output_text,
    params?.turn?.text,
    params?.turn?.outputText,
    params?.turn?.output_text,
    params?.turn?.result?.text,
    params?.turn?.result?.outputText,
    params?.turn?.result?.output_text,
  ];
  for (const value of directText) {
    if (typeof value === "string" && value.length > 0) {
      return normalizeLineEndings(value);
    }
  }

  const contentObjects = [
    params?.content,
    params?.contents,
    params?.output,
    params?.outputs,
    params?.result,
    params?.result?.content,
    params?.result?.contents,
    params?.result?.output,
    params?.result?.outputs,
    params?.turn,
    params?.turn?.content,
    params?.turn?.contents,
    params?.turn?.output,
    params?.turn?.outputs,
    params?.turn?.result,
  ];
  for (const content of contentObjects) {
    const extracted = extractRawTextFromContent(content);
    if (extracted) {
      return extracted;
    }
  }

  const itemCollections = [
    params?.items,
    params?.result?.items,
    params?.turn?.items,
    params?.turn?.result?.items,
  ];
  for (const collection of itemCollections) {
    const extracted = extractAssistantTextFromItems(collection);
    if (extracted) {
      return extracted;
    }
  }

  return "";
}

function extractFailureText(params) {
  const rawMessage = normalizeIdentifier(params?.turn?.error?.message || params?.error?.message);
  return rawMessage ? `❌ Execution failed\n${rawMessage}` : "❌ Execution failed";
}

function normalizeIdentifier(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLineEndings(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function extractRawTextFromContent(content) {
  if (typeof content === "string" && content.length > 0) {
    return normalizeLineEndings(content);
  }

  if (!content) {
    return "";
  }

  if (Array.isArray(content)) {
    const parts = [];
    for (const entry of content) {
      if (typeof entry === "string" && entry.length > 0) {
        parts.push(normalizeLineEndings(entry));
        continue;
      }
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const entryType = String(entry.type || "").toLowerCase();
      if (entryType === "text" && typeof entry.text === "string" && entry.text.length > 0) {
        parts.push(normalizeLineEndings(entry.text));
        continue;
      }
      if (typeof entry.text === "string" && entry.text.length > 0) {
        parts.push(normalizeLineEndings(entry.text));
        continue;
      }
      if (typeof entry.value === "string" && entry.value.length > 0) {
        parts.push(normalizeLineEndings(entry.value));
      }
    }
    return parts.join("");
  }

  if (typeof content !== "object") {
    return "";
  }

  if (typeof content.text === "string" && content.text.length > 0) {
    return normalizeLineEndings(content.text);
  }

  if (typeof content.value === "string" && content.value.length > 0) {
    return normalizeLineEndings(content.value);
  }

  const nested = [
    content.content,
    content.contents,
    content.output,
    content.outputs,
    content.parts,
    content.message,
  ];
  for (const value of nested) {
    const extracted = extractRawTextFromContent(value);
    if (extracted) {
      return extracted;
    }
  }

  return "";
}

function extractAssistantTextFromItems(items) {
  if (!Array.isArray(items) || !items.length) {
    return "";
  }
  const parts = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (!isAssistantItemType(resolveItemTypeFromParams(item))) {
      continue;
    }
    const text = extractAssistantText({ item });
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n\n");
}

function resolveItemTypeFromParams(params) {
  return params?.item?.type || params?.itemType || params?.item_type || params?.type || "";
}

module.exports = {
  extractAssistantText,
  extractFailureText,
  extractItemIdFromParams,
  extractThreadId,
  extractTurnId,
  extractTurnCompletionText,
  extractThreadIdFromParams,
  extractTurnIdFromParams,
  isAssistantItemCompleted,
  isAssistantItemType,
};
