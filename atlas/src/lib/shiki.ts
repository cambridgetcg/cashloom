import type { HighlighterCore, ThemeRegistrationRaw } from "shiki/core";

/**
 * A hand-authored TextMate theme in the loom palette: ink surface, warm
 * amber keywords, gold callables, teal strings (the read/observe hue),
 * ember operators. Code colours share the family with the rest of the atlas
 * so a code pane reads as woven cloth, not a foreign embed.
 */
export const LOOM_THEME: ThemeRegistrationRaw = {
  name: "loom-ink",
  type: "dark",
  bg: "#00000000",
  fg: "#dcd2c0",
  settings: [
    { scope: ["comment", "punctuation.definition.comment", "comment.block", "comment.line"], settings: { foreground: "#776b57", fontStyle: "italic" } },
    { scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control", "keyword.operator.new", "keyword.operator.expression"], settings: { foreground: "#d98a4e" } },
    { scope: ["keyword.operator", "punctuation.accessor"], settings: { foreground: "#c98a5e" } },
    { scope: ["string", "string.quoted", "string.template", "punctuation.definition.string"], settings: { foreground: "#7fb3a5" } },
    { scope: ["constant.character.escape", "punctuation.definition.template-expression"], settings: { foreground: "#c98a5e" } },
    { scope: ["constant.numeric", "constant.language", "constant.language.boolean", "constant.language.null", "constant.language.undefined"], settings: { foreground: "#e0a86a" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call.method", "variable.function"], settings: { foreground: "#e8c07a" } },
    { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class", "entity.name.type.interface"], settings: { foreground: "#cbb78c" } },
    { scope: ["variable", "variable.other", "variable.other.readwrite", "meta.definition.variable"], settings: { foreground: "#ded3c1" } },
    { scope: ["variable.parameter", "variable.other.object"], settings: { foreground: "#c6baa6" } },
    { scope: ["variable.other.property", "support.type.property-name", "meta.object-literal.key", "variable.other.object.property"], settings: { foreground: "#c9b98e" } },
    { scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator", "punctuation.definition.parameters", "meta.delimiter"], settings: { foreground: "#8f8574" } },
    { scope: ["entity.name.tag", "support.type.primitive"], settings: { foreground: "#d98a4e" } },
    { scope: ["keyword.control.import", "keyword.control.from", "keyword.control.export"], settings: { foreground: "#d98a4e", fontStyle: "italic" } },
  ],
};

let hlPromise: Promise<HighlighterCore> | null = null;

/**
 * Lazily create a single shared highlighter. Shiki (grammar + JS regex
 * engine, no wasm) is dynamically imported so it becomes its own chunk and
 * only loads the first time a code pane is opened — the hero and weave paint
 * without waiting on it.
 */
export function getHighlighter(): Promise<HighlighterCore> {
  if (!hlPromise) {
    hlPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, tsLang] =
        await Promise.all([
          import("shiki/core"),
          import("shiki/engine/javascript"),
          import("shiki/langs/typescript.mjs"),
        ]);
      return createHighlighterCore({
        themes: [LOOM_THEME],
        langs: [tsLang.default],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return hlPromise;
}

export type { HighlighterCore };
