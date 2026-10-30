import type { On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";

const reply = (text: string) =>
  ({
    plugin: "mermaid-view",
    component: "AssistantMessage",
    props: { text, isFirstOfReply: true },
  }) as const;

const DIAGRAM = "Before\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter";

const USER_SETTINGS =
  "/home/me/Library/Application Support/Code/User/settings.json";

// Stands for the engine: the clock, HOME, and an editor whose user
// settings.json holds `settings` (none at all when it is undefined).
function engine(on: On, settings?: string) {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine</Text>;
  });
  on("clock.now", () => ({ value: 0 }));
  on("env.get", (_, e) => ({ value: e.name === "HOME" ? "/home/me" : undefined }));
  on("fs.exists", (_, e) => ({
    value: settings !== undefined && e.path === USER_SETTINGS,
  }));
  on("fs.read", () => ({ value: settings ?? "" }));
}

async function svgSource($: Engine, surface: "vscode" | "desktop") {
  const ui = await $.ui.mount({ ...reply(DIAGRAM), surface });
  const source = String((await ui.find({ type: "Svg" }))?.props.source);
  await ui.unmount();
  return source;
}

test("a mermaid block is drawn as an Svg on surfaces that have one", async ($, on) => {
  engine(on);

  for (const surface of ["vscode", "desktop", "mobile"] as const) {
    const ui = await $.ui.mount({ ...reply(DIAGRAM), surface });
    const svg = await ui.find({ type: "Svg" });
    expect(svg).toBeDefined();
    expect(await ui.find({ type: "Text", text: /engine/ })).toBeUndefined();
    await ui.unmount();
  }
});

test("the terminal and replies without a diagram go to the engine", async ($, on) => {
  engine(on);

  const terminal = await $.ui.mount({ ...reply(DIAGRAM), surface: "terminal" });
  expect(await terminal.find({ type: "Text", text: /engine/ })).toBeDefined();
  await terminal.unmount();

  const plain = await $.ui.mount({
    ...reply("no diagram here"),
    surface: "vscode",
  });
  expect(await plain.find({ type: "Text", text: /engine/ })).toBeDefined();
  await plain.unmount();
});

test("a block pele cannot parse stays as code with the error", async ($, on) => {
  engine(on);

  const ui = await $.ui.mount({
    ...reply("```mermaid\nflowchart LR\n  A -->\n```"),
    surface: "vscode",
  });
  expect(await ui.find({ type: "Svg" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: /^mermaid: / })).toBeDefined();
  await ui.unmount();
});

test("VS Code's dark theme draws the dark palette unconditionally", async ($, on) => {
  engine(on, '{\n  // "workbench.colorTheme": "Default Light Modern",\n  "workbench.colorTheme": "One Dark Pro"\n}');
  const source = await svgSource($, "vscode");
  expect(source).toContain("<style>.pele{--pele-bg:#1e1e1e");
});

test("VS Code's light theme draws Pele's light default", async ($, on) => {
  engine(on, '{ "workbench.colorTheme": "Default Light Modern" }');
  expect(await svgSource($, "vscode")).not.toContain("--pele-bg:#1e1e1e");
});

test("no colorTheme setting means VS Code's default, Dark Modern", async ($, on) => {
  engine(on);
  expect(await svgSource($, "vscode")).toContain("<style>.pele{--pele-bg:#1e1e1e");
});

test("autoDetectColorScheme and other surfaces follow prefers-color-scheme", async ($, on) => {
  engine(on, '{ "window.autoDetectColorScheme": true, "workbench.colorTheme": "Default Dark Modern" }');
  expect(await svgSource($, "vscode")).toContain("@media (prefers-color-scheme: dark)");
  expect(await svgSource($, "desktop")).toContain("@media (prefers-color-scheme: dark)");
});
