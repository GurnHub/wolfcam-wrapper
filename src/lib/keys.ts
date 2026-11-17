// WolfcamQL key binds: the catalog of bindable actions, the layouts
// WolfDeck offers, and the translation between browser key events and the
// engine's key names.

export interface KeyAction {
  /** Console command the key runs. Commands starting with "+" act while the key is held. */
  command: string;
  label: string;
  help?: string;
}

export interface KeyGroup {
  id: string;
  title: string;
  actions: KeyAction[];
}

/** key name (as the engine spells it) -> command */
export type BindMap = Record<string, string>;

const a = (command: string, label: string, help?: string): KeyAction => ({ command, label, help });

export const KEY_GROUPS: KeyGroup[] = [
  {
    id: "playback",
    title: "Playback",
    actions: [
      a("pause", "Play / pause"),
      a("rewind 5", "Back 5 seconds"),
      a("fastforward 5", "Forward 5 seconds"),
      a("rewind 30", "Back 30 seconds"),
      a("fastforward 30", "Forward 30 seconds"),
      a("rewind 1", "Back 1 second"),
      a("fastforward 1", "Forward 1 second"),
      a("seekprev", "Step back one frame", "One demo snapshot."),
      a("seeknext", "Step forward one frame", "One demo snapshot."),
      a("seekprevround", "Previous round"),
      a("seeknextround", "Next round"),
      a("+mouseseek", "Scrub with the mouse", "Hold and move the mouse left or right."),
      a("fragforward 5", "Frag forward on / off", "Jumps from kill to kill of the followed player."),
    ],
  },
  {
    id: "speed",
    title: "Speed",
    actions: [
      a("timescale 0.1", "Speed 0.1×"),
      a("timescale 0.25", "Speed 0.25×"),
      a("timescale 0.5", "Speed 0.5×"),
      a("timescale 1", "Real time"),
      a("timescale 2", "Speed 2×"),
      a("timescale 4", "Speed 4×"),
      a("timescale 100", "Fast scan (100×)"),
    ],
  },
  {
    id: "view",
    title: "View",
    actions: [
      a("freecam", "Free camera on / off"),
      a("follow -1", "Back to the demo taker"),
      a("follow killer", "Follow the killer"),
      a("follow victim", "Follow the victim"),
      a("toggle cg_thirdPerson", "Third person on / off"),
      a("toggle cg_draw2D", "HUD on / off"),
      a("toggle cg_drawGun", "Weapon on / off"),
      a("toggle cg_drawEntNumbers", "Entity numbers on / off"),
      a("+scores", "Scoreboard", "While held."),
      a("+info", "Demo and server info", "While held."),
      a("+acc", "Weapon stats", "While held."),
      a("+chat", "Chat history", "While held."),
    ],
  },
  {
    id: "move",
    title: "Free camera movement",
    actions: [
      a("+forward", "Forward"),
      a("+back", "Back"),
      a("+moveleft", "Left"),
      a("+moveright", "Right"),
      a("+moveup", "Up"),
      a("+movedown", "Down"),
      a("+speed", "Change speed", "Walk / run modifier, while held."),
      a("+rollleft", "Roll left"),
      a("+rollright", "Roll right"),
      a("centerroll", "Level the roll"),
      a("stopmovement", "Stop drifting"),
    ],
  },
  {
    id: "camera",
    title: "Camera points",
    actions: [
      a("addcamerapoint", "Add camera point", "At the time of an existing point it updates that point."),
      a("selectcamerapoint last; deletecamerapoint", "Undo camera point", "Removes the newest point."),
      a("editcamerapoint previous", "Edit previous point"),
      a("editcamerapoint next", "Edit next point"),
      a("clearcamerapoints", "Start over", "Removes every camera point."),
      a("playcamera", "Play camera"),
      a("stopcamera", "Stop camera"),
      a("toggle cg_drawCameraPath", "Camera path on / off"),
      a("toggle cg_drawCameraPointInfo", "Camera point info on / off"),
      a("prevfield", "Camera point editor: previous field"),
      a("nextfield", "Camera point editor: next field"),
      a("changefield", "Camera point editor: change field"),
    ],
  },
  {
    id: "record",
    title: "Recording and loop",
    actions: [
      a("video avi name :demoname", "Start recording video", "Named after the demo."),
      a("stopvideo", "Stop recording video"),
      a("screenshotJPEG", "Screenshot"),
      a("setloopstart", "Set loop start"),
      a("setloopend", "Set loop end"),
      a("loop", "Loop on / off"),
    ],
  },
  {
    id: "system",
    title: "WolfcamQL",
    actions: [
      a("togglemenu", "Menu"),
      a("toggleconsole", "Console"),
      a("toggle in_nograb", "Mouse capture on / off"),
      a("toggle r_fullscreen", "Fullscreen on / off"),
      a("echopopupcvar cl_demoFileBaseName", "Show the demo's name"),
      a("quit", "Quit WolfcamQL"),
    ],
  },
];

/** A layout built for demo viewing and movie making: media-player keys, WASD free camera, camera tools on one hand. */
export const WOLFDECK_LAYOUT: BindMap = {
  SPACE: "pause",
  LEFTARROW: "rewind 5", RIGHTARROW: "fastforward 5",
  DOWNARROW: "rewind 30", UPARROW: "fastforward 30",
  MWHEELDOWN: "rewind 1", MWHEELUP: "fastforward 1",
  ",": "seekprev", ".": "seeknext",
  PGDN: "seekprevround", PGUP: "seeknextround",
  MOUSE2: "+mouseseek",
  n: "fragforward 5",
  "1": "timescale 0.1", "2": "timescale 0.25", "3": "timescale 0.5", "4": "timescale 1", "5": "timescale 2", "6": "timescale 4", "0": "timescale 100",
  f: "freecam", BACKSPACE: "follow -1", k: "follow killer", j: "follow victim",
  t: "toggle cg_thirdPerson", h: "toggle cg_draw2D", g: "toggle cg_drawGun",
  TAB: "+scores", ALT: "+info", CTRL: "+acc", y: "+chat",
  w: "+forward", s: "+back", a: "+moveleft", d: "+moveright", e: "+moveup", q: "+movedown", SHIFT: "+speed",
  z: "+rollleft", c: "+rollright", x: "centerroll", r: "stopmovement",
  v: "addcamerapoint", u: "selectcamerapoint last; deletecamerapoint",
  "[": "editcamerapoint previous", "]": "editcamerapoint next",
  o: "playcamera", p: "stopcamera", DEL: "clearcamerapoints",
  b: "toggle cg_drawCameraPath", i: "toggle cg_drawCameraPointInfo",
  KP_UPARROW: "prevfield", KP_DOWNARROW: "nextfield", KP_ENTER: "changefield",
  F5: "setloopstart", F6: "setloopend", F7: "loop",
  F9: "video avi name :demoname", F10: "stopvideo", F12: "screenshotJPEG",
  ESCAPE: "togglemenu", "`": "toggleconsole", F2: "toggle in_nograb", F11: "toggle r_fullscreen",
};

/** What WolfcamQL ships with (its defaultwolfcam.cfg), plus the usual movement and menu keys. */
export const WOLFCAM_DEFAULTS: BindMap = {
  ENTER: "freecam", PAUSE: "pause",
  KP_ENTER: "changefield", KP_UPARROW: "prevfield", KP_DOWNARROW: "nextfield",
  UPARROW: "fastforward 60", DOWNARROW: "rewind 60", LEFTARROW: "rewind 10", RIGHTARROW: "fastforward 10",
  "-": "rewind 0.3", "=": "fastforward 0.3", "9": "seekprev", "0": "seeknext",
  e: "+rollright", q: "+rollleft", f: "+rollstopzero", "2": "stopmovement", "3": "centerroll",
  CTRL: "+acc", KP_INS: "timescale 1", KP_END: "timescale 0.1", KP_HOME: "timescale 100",
  MOUSE2: "+moveup", F2: "toggle in_nograb", F4: "quit", F6: "echopopupcvar cl_demoFileBaseName", F11: "screenshotPNG",
  "4": "toggle cg_drawCameraPointInfo", "5": "toggle cg_drawCameraPath",
  "[": "editcamerapoint previous", "]": "editcamerapoint next", o: "playcamera", v: "cg_draw2d 2; addcamerapoint",
  BACKSPACE: "toggle cg_draw2d 0 1 2", i: "toggle cl_avifetchmode gl_rgb gl_rgba gl_bgr gl_bgra; echopopupcvar cl_avifetchmode",
  ALT: "+info", SHIFT: "+mouseseek", ".": "+chat",
  w: "+forward", s: "+back", a: "+moveleft", d: "+moveright", SPACE: "+moveup", c: "+movedown", TAB: "+scores",
  ESCAPE: "togglemenu", "`": "toggleconsole",
};

export const ALL_KEYS: string[] = [
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
  "SPACE", "ENTER", "TAB", "ESCAPE", "BACKSPACE", "SHIFT", "CTRL", "ALT", "CAPSLOCK",
  "UPARROW", "DOWNARROW", "LEFTARROW", "RIGHTARROW", "INS", "DEL", "HOME", "END", "PGUP", "PGDN", "PAUSE",
  "`", "-", "=", "[", "]", "\\", "SEMICOLON", "'", ",", ".", "/",
  ...Array.from({ length: 15 }, (_, i) => `F${i + 1}`),
  "MOUSE1", "MOUSE2", "MOUSE3", "MOUSE4", "MOUSE5", "MWHEELUP", "MWHEELDOWN",
  "KP_HOME", "KP_UPARROW", "KP_PGUP", "KP_LEFTARROW", "KP_5", "KP_RIGHTARROW", "KP_END", "KP_DOWNARROW", "KP_PGDN",
  "KP_ENTER", "KP_INS", "KP_DEL", "KP_SLASH", "KP_STAR", "KP_MINUS", "KP_PLUS", "KP_NUMLOCK",
];

const CODE_TO_KEY: Record<string, string> = {
  Space: "SPACE", Enter: "ENTER", Tab: "TAB", Escape: "ESCAPE", Backspace: "BACKSPACE", CapsLock: "CAPSLOCK",
  ShiftLeft: "SHIFT", ShiftRight: "SHIFT", ControlLeft: "CTRL", ControlRight: "CTRL", AltLeft: "ALT", AltRight: "ALT",
  ArrowUp: "UPARROW", ArrowDown: "DOWNARROW", ArrowLeft: "LEFTARROW", ArrowRight: "RIGHTARROW",
  Insert: "INS", Delete: "DEL", Home: "HOME", End: "END", PageUp: "PGUP", PageDown: "PGDN", Pause: "PAUSE",
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: "SEMICOLON",
  Quote: "'", Comma: ",", Period: ".", Slash: "/",
  Numpad0: "KP_INS", Numpad1: "KP_END", Numpad2: "KP_DOWNARROW", Numpad3: "KP_PGDN", Numpad4: "KP_LEFTARROW", Numpad5: "KP_5",
  Numpad6: "KP_RIGHTARROW", Numpad7: "KP_HOME", Numpad8: "KP_UPARROW", Numpad9: "KP_PGUP", NumpadEnter: "KP_ENTER",
  NumpadDecimal: "KP_DEL", NumpadDivide: "KP_SLASH", NumpadMultiply: "KP_STAR", NumpadSubtract: "KP_MINUS", NumpadAdd: "KP_PLUS", NumLock: "KP_NUMLOCK",
};

/** Engine key name for a browser keyboard event, or null when the key has no engine name. */
export function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-5])$/.test(code)) return code;
  return CODE_TO_KEY[code] ?? null;
}

export function keyFromMouseButton(button: number): string | null {
  return ["MOUSE1", "MOUSE3", "MOUSE2", "MOUSE4", "MOUSE5"][button] ?? null;
}

const PRETTY: Record<string, string> = {
  SPACE: "Space", ENTER: "Enter", TAB: "Tab", ESCAPE: "Esc", BACKSPACE: "Backspace", SHIFT: "Shift", CTRL: "Ctrl", ALT: "Alt", CAPSLOCK: "Caps Lock",
  UPARROW: "↑", DOWNARROW: "↓", LEFTARROW: "←", RIGHTARROW: "→", INS: "Insert", DEL: "Delete", HOME: "Home", END: "End", PGUP: "Page Up", PGDN: "Page Down",
  PAUSE: "Pause", SEMICOLON: ";", MOUSE1: "Left mouse", MOUSE2: "Right mouse", MOUSE3: "Middle mouse", MOUSE4: "Mouse 4", MOUSE5: "Mouse 5",
  MWHEELUP: "Wheel up", MWHEELDOWN: "Wheel down",
  KP_HOME: "Num 7", KP_UPARROW: "Num 8", KP_PGUP: "Num 9", KP_LEFTARROW: "Num 4", KP_5: "Num 5", KP_RIGHTARROW: "Num 6", KP_END: "Num 1",
  KP_DOWNARROW: "Num 2", KP_PGDN: "Num 3", KP_ENTER: "Num Enter", KP_INS: "Num 0", KP_DEL: "Num .", KP_SLASH: "Num /", KP_STAR: "Num *",
  KP_MINUS: "Num -", KP_PLUS: "Num +", KP_NUMLOCK: "Num Lock",
};

/** Label for a key cap. */
export function prettyKey(key: string): string {
  const k = canonicalKey(key);
  return PRETTY[k] ?? (k.length === 1 ? k.toUpperCase() : k);
}

/** The engine ignores case in key names; WolfDeck stores letters lower-case and names upper-case. */
export function canonicalKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key.toUpperCase();
}

export function normalizeBinds(pairs: [string, string][]): BindMap {
  const out: BindMap = {};
  for (const [k, c] of pairs) if (c.trim()) out[canonicalKey(k)] = c.trim();
  return out;
}

/** Console commands that replace every bind in the engine with this map. */
export function bindCommands(binds: BindMap): string[] {
  return ["unbindall", ...Object.entries(binds).map(([k, c]) => `bind ${k} "${c.replace(/"/g, "")}"`)];
}

/** Keys bound to a command, compared the way the engine would run it. */
export function keysFor(binds: BindMap, command: string): string[] {
  const want = command.toLowerCase();
  return Object.keys(binds).filter((k) => binds[k].toLowerCase() === want);
}

const KNOWN = new Set(KEY_GROUPS.flatMap((g) => g.actions.map((x) => x.command.toLowerCase())));

/** Binds whose command is not one of the catalogued actions. */
export function customBinds(binds: BindMap): [string, string][] {
  return Object.entries(binds).filter(([, c]) => !KNOWN.has(c.toLowerCase()));
}

export function sameBinds(x: BindMap, y: BindMap): boolean {
  const kx = Object.keys(x);
  return kx.length === Object.keys(y).length && kx.every((k) => x[k] === y[k]);
}
