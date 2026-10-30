import type { EngineInterface, Register } from "claude-code";

import { render } from "./vendor/pele.js";

type Theme = "auto" | "light" | "dark";

type Segment =
  | { kind: "text"; text: string }
  | { kind: "mermaid"; source: string };

type Drawn = { svg: string } | { error: string };

// A closed fence only: a block still streaming has no closing fence yet and stays text.
const FENCE =
  /^([ \t]*)(```|~~~)[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)\r?\n\1\2[ \t]*$/gm;

// The Svg element takes at most this many characters.
const MAX_SVG = 131072;

// Pele's light theme is its default; these override it for dark editors.
const DARK_VARS =
  "--pele-bg:#1e1e1e;--pele-fg:#e6e6e6;--pele-muted:#9a9a9a;--pele-line:#d4d4d4;" +
  "--pele-surface:#2b2b2b;--pele-surface-alt:#3a3a3a;--pele-border:#6e6e6e;--pele-accent:#7b9be5";

function split(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(FENCE)) {
    const before = text.slice(last, match.index);
    if (before.trim()) segments.push({ kind: "text", text: before });
    segments.push({ kind: "mermaid", source: match[3] ?? "" });
    last = match.index + match[0].length;
  }
  const rest = text.slice(last);
  if (rest.trim()) segments.push({ kind: "text", text: rest });
  return segments;
}

// The surfaces draw the SVG as an image, so its colors must live inside it:
// an opaque background keeps it legible even where the scheme guess is wrong.
function themed(svg: string, theme: Theme): string {
  const style =
    theme === "dark"
      ? `<style>.pele{${DARK_VARS}}</style>`
      : theme === "auto"
        ? `<style>@media (prefers-color-scheme: dark){.pele{${DARK_VARS}}}</style>`
        : "";
  const backdrop =
    '<rect x="-1e5" y="-1e5" width="2e5" height="2e5" fill="var(--_bg)"/>';
  return svg.replace(/^<svg[^>]*>/, `$&${style}${backdrop}`);
}

const cache = new Map<string, Drawn>();

function draw(source: string, theme: Theme): Drawn {
  const id = `${theme}\n${source}`;
  const hit = cache.get(id);
  if (hit) return hit;
  let drawn: Drawn;
  try {
    const svg = themed(render(source).svg, theme);
    drawn =
      svg.length > MAX_SVG ? { error: "diagram too large to draw" } : { svg };
  } catch (error) {
    drawn = { error: error instanceof Error ? error.message : String(error) };
  }
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  cache.set(id, drawn);
  return drawn;
}

// The editor draws the SVG as an image whose prefers-color-scheme follows the
// OS appearance, not the editor's theme, so the editor's settings decide.
const EDITORS = ["Code", "Code - Insiders", "Cursor"];

function settingsPaths(home?: string, appData?: string): string[] {
  const paths = [".vscode/settings.json"];
  for (const editor of EDITORS) {
    if (home) {
      paths.push(
        `${home}/Library/Application Support/${editor}/User/settings.json`,
      );
      paths.push(`${home}/.config/${editor}/User/settings.json`);
    }
    if (appData) paths.push(`${appData}\\${editor}\\User\\settings.json`);
  }
  return paths;
}

// Settings are JSONC; a key on a commented-out line does not count.
const setting = (text: string, key: string, value: string) =>
  new RegExp(
    `^(?!\\s*//).*?"${key.replace(".", "\\.")}"\\s*:\\s*${value}`,
    "m",
  ).exec(text)?.[1];

async function editorTheme($: EngineInterface): Promise<Theme> {
  const paths = settingsPaths(
    await $.env.get("HOME"),
    await $.env.get("APPDATA"),
  );
  for (const path of paths) {
    let text: string;
    try {
      if (!(await $.fs.exists(path))) continue;
      text = await $.fs.read(path);
    } catch {
      continue;
    }
    if (setting(text, "window.autoDetectColorScheme", "(true)")) return "auto";
    const name = setting(text, "workbench.colorTheme", '"([^"]*)"');
    if (name !== undefined) return /light/i.test(name) ? "light" : "dark";
  }
  // VS Code's default theme, Dark Modern.
  return "dark";
}

const THEME_TTL_MS = 30_000;

let resolved: { theme: Theme; at: number } | undefined;

async function themeFor(
  $: EngineInterface,
  configured: Theme,
  surface: string,
): Promise<Theme> {
  if (configured !== "auto" || surface !== "vscode") return configured;
  const now = await $.clock.now();
  if (!resolved || now - resolved.at > THEME_TTL_MS) {
    resolved = { theme: await editorTheme($), at: now };
  }
  return resolved.theme;
}

export const register: Register = (on, options) => {
  const configured: Theme =
    options.theme === "light" || options.theme === "dark"
      ? options.theme
      : "auto";

  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
    if (e.surface === "terminal" || e.props.isSummary) return next(e);

    const segments = split(e.props.text);
    if (!segments.some((segment) => segment.kind === "mermaid")) return next(e);

    const ui = $.ui.resolve(e);
    if (!("Svg" in ui)) return next(e);
    const { Box, Button, Markdown, Svg, Text } = ui;
    const theme = await themeFor($, configured, e.surface);

    return (
      <Box flexDirection="column">
        {segments.map((segment, index) => {
          if (segment.kind === "text")
            return <Markdown key={`t${index}`} text={segment.text} />;

          const fence = "```mermaid\n" + segment.source + "\n```";
          const drawn = draw(segment.source, theme);
          if ("error" in drawn) {
            return (
              <Box key={`m${index}`} flexDirection="column">
                <Markdown text={fence} />
                <Text dimColor>mermaid: {drawn.error}</Text>
              </Box>
            );
          }
          return (
            <Box key={`m${index}`} flexDirection="column">
              <Svg source={drawn.svg} alt={`mermaid diagram ${index + 1}`} />
              <Button
                key={`copy${index}`}
                label="Copy mermaid source"
                onPress={(press) =>
                  $.ui.copy({ text: segment.source, surface: press.surface })
                }
              />
            </Box>
          );
        })}
      </Box>
    );
  });
};
