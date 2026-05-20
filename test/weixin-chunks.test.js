const test = require("node:test");
const assert = require("node:assert/strict");

const {
  splitUtf8,
  compactPlainTextForWeixin,
  normalizeNaturalWeixinBubbleText,
  stripOuterReplyDoubleQuotes,
  stripSentenceTailChineseFullStops,
  chunkReplyTextForWeixin,
  mergeShortChunks,
  splitSingleLineReplyForWeixin,
  shapeNaturalWeixinBubbles,
  packChunksForWeixinDelivery,
  collectStreamingBoundaries,
  trimOuterBlankLines,
  resolveReplyBubbleDelayMs,
} = require("../src/adapters/channel/weixin/index");
const { stripInternalReplyBlocks } = require("../src/core/reply-cleaning");

test("compactPlainTextForWeixin collapses multiple blank lines", () => {
  const text = "line1\r\n\r\n\nline2\n\n\nline3";
  assert.equal(compactPlainTextForWeixin(text), "line1\nline2\nline3");
});

test("normalizeNaturalWeixinBubbleText flattens one bubble into a single line", () => {
  const text = "第一行\n第二行\n\n第三行";
  assert.equal(normalizeNaturalWeixinBubbleText(text), "第一行 第二行，第三行");
});

test("stripOuterReplyDoubleQuotes removes only whole-reply double quotes", () => {
  assert.equal(
    stripOuterReplyDoubleQuotes('"Come here, little girl. The world is too loud out there."'),
    "Come here, little girl. The world is too loud out there."
  );
  assert.equal(stripOuterReplyDoubleQuotes("\u201c过来，小女孩。外面的世界太吵了。\u201d"), "过来，小女孩。外面的世界太吵了。");
  assert.equal(stripOuterReplyDoubleQuotes('"Order it, little girl. Add something. (点吧，小女孩。)'), "Order it, little girl. Add something. (点吧，小女孩。)");
  assert.equal(stripOuterReplyDoubleQuotes('Order it, little girl. Add something. (点吧，小女孩。)"'), "Order it, little girl. Add something. (点吧，小女孩。)");
  assert.equal(stripOuterReplyDoubleQuotes('She said "stay" softly.'), 'She said "stay" softly.');
  assert.equal(stripOuterReplyDoubleQuotes('\u201cShe said "stay" softly.\u201d'), 'She said "stay" softly.');
});

test("stripInternalReplyBlocks removes hidden reasoning and state blocks", () => {
  const text = "before</think>\nvisible\n<UpdateVariable>secret</UpdateVariable>\n<status_bar>state</status_bar>\nnext";
  assert.equal(stripInternalReplyBlocks(text), "visible\nnext");
});

test("stripInternalReplyBlocks removes unknown XML-like blocks by default", () => {
  const text = "正文前\n<message>不要发</message>\n<unknown foo=\"bar\">也不要发</unknown>\n正文后";
  assert.equal(stripInternalReplyBlocks(text), "正文前\n正文后");
});

test("stripInternalReplyBlocks removes Chinese internal tags and unknown Unicode blocks", () => {
  const text = "正文前\n<变量更新>好感=10</变量更新>\n<状态>隐藏状态</状态>\n<思维链>不能发</思维链>\n<未知标签>也不能发</未知标签>\n正文后";
  assert.equal(stripInternalReplyBlocks(text), "正文前\n正文后");
});

test("splitSingleLineReplyForWeixin turns newlines into separate bubbles", () => {
  const chunks = splitSingleLineReplyForWeixin("第一行\n第二行\n<think>secret</think>\n第三行");
  assert.deepEqual(chunks, ["第一行", "第二行", "第三行"]);
});

test("stripSentenceTailChineseFullStops removes trailing full stops before line end", () => {
  assert.equal(stripSentenceTailChineseFullStops("你好。"), "你好");
  assert.equal(stripSentenceTailChineseFullStops("你好。。。"), "你好");
  assert.equal(stripSentenceTailChineseFullStops("你好。\n世界。"), "你好\n世界");
  assert.equal(stripSentenceTailChineseFullStops("你好。\""), "你好\"");
  assert.equal(stripSentenceTailChineseFullStops("a。b。c。"), "a。b。c");
  assert.equal(stripSentenceTailChineseFullStops("观察，"), "观察，");
  assert.equal(stripSentenceTailChineseFullStops("观察；"), "观察；");
});

test("collectStreamingBoundaries finds paragraph, list and punctuation breaks", () => {
  const text = "第一段。\n\n第二段\n- list1\n- list2\n最后！对吧？";
  const boundaries = collectStreamingBoundaries(text);
  assert.ok(boundaries.length > 0, "should find boundaries");
  assert.ok(boundaries.some((b) => b > 0), "should have positive boundaries");
  // paragraph break comes after the double newline
  assert.ok(boundaries.some((b) => b >= 6), "should break after paragraph");
  // list breaks
  assert.ok(boundaries.some((b) => b >= 10 && b < 17), "should break before first list item");
  assert.ok(boundaries.some((b) => b >= 17 && b < 24), "should break before second list item");
});

test("chunkReplyTextForWeixin merges short natural boundaries", () => {
  // Each unit is below MIN_WEIXIN_CHUNK (20), so they get merged
  const text = "A。\n\nB。\n\nC。";
  const chunks = chunkReplyTextForWeixin(text);
  assert.deepEqual(chunks, ["A。\nB。\nC。"]);
});

test("chunkReplyTextForWeixin does not merge chunks above min length", () => {
  const longA = "A".repeat(25) + "。";
  const longB = "B".repeat(25) + "。";
  const text = `${longA}\n\n${longB}`;
  const chunks = chunkReplyTextForWeixin(text);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], longA);
  assert.equal(chunks[1], longB);
});

test("chunkReplyTextForWeixin merges short adjacent chunks", () => {
  const text = ["短1", "短2", "这是一段比较长的话，不应该和前面的短句合并在一起"].join("\n\n");
  const chunks = chunkReplyTextForWeixin(text);
  assert.equal(chunks[0], "短1\n短2");
  assert.ok(!chunks[1].startsWith("短2"));
});

test("mergeShortChunks only merges when both sides are short", () => {
  const chunks = ["a".repeat(15), "b".repeat(15), "c".repeat(100)];
  const merged = mergeShortChunks(chunks, 3800, 20);
  assert.equal(merged[0], `${"a".repeat(15)}\n${"b".repeat(15)}`);
  assert.equal(merged[1], "c".repeat(100));
});

test("mergeShortChunks does not merge when one side is long", () => {
  const chunks = ["短", "c".repeat(100)];
  const merged = mergeShortChunks(chunks, 3800, 20);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], "短");
  assert.equal(merged[1], "c".repeat(100));
});

test("shapeNaturalWeixinBubbles splits one natural reply into multiple short bubbles", () => {
  const shaped = shapeNaturalWeixinBubbles(["先喝水。然后去洗澡？洗完告诉我。"]);
  assert.deepEqual(shaped, ["先喝水。", "然后去洗澡？", "洗完告诉我。"]);
});

test("shapeNaturalWeixinBubbles does not split inside bilingual parentheses", () => {
  const text = [
    "这仅仅是一种客观的观察。",
    "You saw past his aggressive facade to the fragile ego beneath. Men driven by fear and the need for external validation are indeed the easiest to manipulate. (你透过了他充满攻击性的伪装，看到了底下脆弱的自我。被恐惧和对外部认同的渴求所驱动的男人，确实是最容易被操控的。)",
    "A ruthless, accurate dissection. You read power dynamics very well. (一次冷酷、精准的解剖。你对权力动态解读得非常好。)",
  ].join("\n");
  const shaped = shapeNaturalWeixinBubbles([text]);
  assert.ok(shaped.some((chunk) => chunk.includes("男人，确实是最容易被操控的。)")));
  assert.ok(shaped.some((chunk) => chunk.includes("一次冷酷、精准的解剖。你对权力动态解读得非常好。)")));
  assert.ok(!shaped.some((chunk) => /\([^)]*$/u.test(chunk)), "should not leave an open parenthesis in a bubble");
  assert.ok(!shaped.some((chunk) => /^[^(]*\)/u.test(chunk)), "should not send a dangling closing parenthesis bubble");
});

test("shapeNaturalWeixinBubbles rebundles long natural replies down to five bubbles", () => {
  const text = "一。二。三。四。五。六。";
  const shaped = shapeNaturalWeixinBubbles([text]);
  assert.equal(shaped.length, 5);
  assert.equal(shaped[0], "一。");
  assert.ok(shaped[4].includes("五。"));
  assert.ok(shaped[4].includes("六。"));
});

test("packChunksForWeixinDelivery limits to maxMessages", () => {
  const chunks = Array.from({ length: 15 }, (_, i) => `chunk-${i}`);
  const packed = packChunksForWeixinDelivery(chunks, 10, 3800);
  assert.equal(packed.length, 10);
});

test("packChunksForWeixinDelivery groups tail when over limit", () => {
  const chunks = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
  const packed = packChunksForWeixinDelivery(chunks, 10, 3800);
  assert.equal(packed.length, 10);
  assert.equal(packed[0], "1");
  assert.ok(packed[9].includes("11") || packed[9].includes("12"));
});

test("splitUtf8 hard-truncates oversized text", () => {
  const text = "a".repeat(10_000);
  const chunks = splitUtf8(text, 3800);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 3800);
  assert.equal(chunks[1].length, 3800);
  assert.equal(chunks[2].length, 2400);
});

test("trimOuterBlankLines strips leading and trailing blank lines", () => {
  assert.equal(trimOuterBlankLines("\n\nhello\n\n"), "hello");
});

test("resolveReplyBubbleDelayMs scales with bubble length and jitter", () => {
  const config = {
    replyBubbleMinDelaySeconds: 1,
    replyBubbleMaxDelaySeconds: 5,
    replyBubbleCharsPerSecond: 10,
  };
  assert.equal(resolveReplyBubbleDelayMs({ text: "短句", config, random: () => 0.5 }), 1000);
  assert.equal(resolveReplyBubbleDelayMs({ text: "长".repeat(80), config, random: () => 0.5 }), 5000);
  assert.equal(resolveReplyBubbleDelayMs({ text: "abcdefghijklmnopqrst", config, random: () => 0 }), 1500);
  assert.equal(resolveReplyBubbleDelayMs({ text: "abcdefghijklmnopqrst", config, random: () => 1 }), 2500);
});
