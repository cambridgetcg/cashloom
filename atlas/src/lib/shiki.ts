import type { HighlighterCore, ThemeRegistrationRaw } from "shiki/core";

/**
 * Readable syntax colours on the shared ivory surface. TextMate requires
 * concrete colours, so keep these aligned with ui/theme.css's semantic palette.
 */
export const LOOM_THEME: ThemeRegistrationRaw = {
  name: "cashloom-paper",
  type: "light",
  bg: "#00000000",
  fg: "#183a30",
  settings: [
    { scope: ["comment", "punctuation.definition.comment", "comment.block", "comment.line"], settings: { foreground: "#66756b", fontStyle: "italic" } },
    { scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control", "keyword.operator.new", "keyword.operator.expression"], settings: { foreground: "#76571b" } },
    { scope: ["keyword.operator", "punctuation.accessor"], settings: { foreground: "#76571b" } },
    { scope: ["string", "string.quoted", "string.template", "punctuation.definition.string"], settings: { foreground: "#255b46" } },
    { scope: ["constant.character.escape", "punctuation.definition.template-expression"], settings: { foreground: "#76571b" } },
    { scope: ["constant.numeric", "constant.language", "constant.language.boolean", "constant.language.null", "constant.language.undefined"], settings: { foreground: "#245e78" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call.method", "variable.function"], settings: { foreground: "#255b46" } },
    { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class", "entity.name.type.interface"], settings: { foreground: "#245e78" } },
    { scope: ["variable", "variable.other", "variable.other.readwrite", "meta.definition.variable"], settings: { foreground: "#183a30" } },
    { scope: ["variable.parameter", "variable.other.object"], settings: { foreground: "#57685e" } },
    { scope: ["variable.other.property", "support.type.property-name", "meta.object-literal.key", "variable.other.object.property"], settings: { foreground: "#245e78" } },
    { scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator", "punctuation.definition.parameters", "meta.delimiter"], settings: { foreground: "#57685e" } },
    { scope: ["entity.name.tag", "support.type.primitive"], settings: { foreground: "#76571b" } },
    { scope: ["keyword.control.import", "keyword.control.from", "keyword.control.export"], settings: { foreground: "#76571b", fontStyle: "italic" } },
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
