# WolfDeck

A desktop front end for [WolfcamQL](https://github.com/brugal/wolfcamql), the Quake Live / Quake 3 demo player. It covers what Wolf Whisperer did (demo organiser, media-player style playback control, recording and encoding, settings GUI, camera tools, voice-over demos) and adds a demo parser, a frag finder, a clip list with unattended batch rendering, and config profiles.

WolfDeck does not include or modify WolfcamQL. It starts the WolfcamQL you already have and drives it through its command line, config files and console commands.

Built with [Tauri 2](https://tauri.app) (Rust backend, React + TypeScript UI). Runs on Windows, Linux and macOS.

![Library with the detail panel of a demo](docs/library.png)

| Player | Config | Keys |
| --- | --- | --- |
| ![Player](docs/player.png) | ![Config](docs/config.png) | ![Keys](docs/keys.png) |

| Frag finder | Clips & render |
| --- | --- |
| ![Frag finder](docs/frags.png) | ![Clips and render](docs/clips.png) |

Screenshots show the built-in sample data.

## Features

**Library**
- Indexes any number of demo folders (recursively). Reads Quake Live `.dm_73`, `.dm_90`, `.dm_91` and Quake 3 `.dm_66`–`.dm_71` directly: map, mode, server, date, players, who recorded it, length, every kill and the chat.
- Search across file name, map, players, server, tags and notes; filter by mode, map, tag, favourites; sort by any column.
- Favourites, tags and notes per demo. Rename, move, delete to the recycle bin, show in folder.
- Per-demo kill timeline, kill list, player list with kills/deaths, chat log. Play from any kill or from any player's point of view.

**Player** (remote control for a running WolfcamQL)
- Play/pause, seek ±5 s / ±30 s, click-to-seek timeline with kill markers, previous/next kill, speed from 0.05× to 100×.
- Mark in/out, add the range to the clip list, or loop it.
- Record video of what is playing, record a shorter demo out of the current one, take screenshots, reload the demo with changed settings.
- Follow any player, the killer or the victim; free camera; third person; HUD, weapon, crosshair, wallhack and entity-number toggles; a button that cycles the position of the watched player's name; look at or chase any entity (a rocket, a grenade); frag forward.
- Camera tools: add point, undo point, edit previous/next point, start over, play; path type for new points (curve, spline, Bezier, Catmull-Rom, straight, jump) or for all points; free camera speed and sensitivity; camera point info and path drawing; save and load cameras; record and replay movement paths.
- Fullscreen toggle, video restart, volume, and shortcuts to the videos, screenshots and recorded-demos folders.
- Voice-over: attach an audio file to a demo and it plays in sync with the demo position.
- Console with history, WolfcamQL log output, and your own quick-command buttons.
- WolfcamQL can also be opened without a demo.

**Frag finder**
- Searches the kills of the whole library or a selection: by killer, victim, weapons, number of kills in a row and the gap allowed between them.
- Play a result to check it, or add one or many to the clip list.

**Clips & render**
- Clip list with editable name, start/end and point of view.
- Capture presets: resolution (up to 4K, vertical and square included), frame rate, motion blur, AVI codec or image sequences, optional depth pass, extra cvars.
- Unattended batch render: WolfcamQL is started once per clip, records exactly the clip and quits.
- Optional ffmpeg encode per clip: H.264, H.264 for YouTube, H.265, ProRes 422 HQ, DNxHR HQ, FFV1, or your own arguments. Progress per clip, cancel at any time.
- Shows the capture size per minute and the free disk space, and warns when a batch will not fit.

**Config**
- Profiles (for example "Viewing" and "Movie") made of typed settings: view, HUD, frag messages, players, effects, overlays, graphics, audio, plus free-form extra commands.
- HUD chooser: Quake Live HUD, compact HUD, Quake 3 HUD, or a custom `.menu` file. Position of the watched player's name (top or bottom, left, centre or right, or hidden).
- Frag message editor with the token reference (`%v`, `%k`, `%i` ...), position, scale, colour and display time.
- Settings the engine only applies after `vid_restart` are marked. Starting a demo or render does the restart when needed; **Apply now** sends a profile to a running WolfcamQL and offers the restart.
- A profile only sets what you tell it to; everything else stays as it is in your own WolfcamQL config.
- **Restore default profiles** puts the built-in profiles back to how they shipped; each built-in profile can also be reset on its own. Your own profiles are kept.
- Export a profile as a `.cfg` file.

**Keys**
- Shows every WolfcamQL key bind as an action with its keys: playback, speed, view, free camera movement, camera points, recording and loop, plus binds to any other console command.
- Assign a key by pressing it (keyboard, mouse buttons and wheel) or by choosing it from a list; a key that is already taken is shown with what it currently does.
- Layouts: the WolfDeck layout (Space to pause, arrows and wheel to seek, number keys for speed, WASD free camera, camera tools on V / U / O / P / brackets), WolfcamQL's own defaults, or the binds imported from your WolfcamQL config.
- Off until you switch on "Use these keys in WolfcamQL". From then on WolfDeck sets exactly this list each time it starts WolfcamQL, and sends changes straight away while it is running. The binds WolfcamQL had before are kept and can be loaded again.

**Setup**
- Detects WolfcamQL, Quake Live (Steam) and ffmpeg where it can.
- Checks that WolfcamQL has the Quake Live pak files and copies missing ones ("Sync paks").

## Requirements

- WolfcamQL 12 or newer, with the Quake Live pak files in its `baseq3` (WolfDeck can copy them from a Quake Live install).
- ffmpeg, only if you want renders encoded to MP4/MOV/MKV.
- Windows 10/11 (WebView2, preinstalled on current Windows), Linux with WebKitGTK 4.1, or macOS.

## Getting it

Download the installer for Windows, Linux or macOS from the [Releases](https://github.com/GurnHub/wolfcam-wrapper/releases) page. Releases are built by the `release` workflow, started either by pushing a version tag (for example `v0.1.0-alpha.1`) or from the Actions tab with the tag to create; the release text comes from `docs/releases/<tag>.md`. Every other push also builds installers in the `build` workflow, available as that run's artifacts.

To build it yourself you need Node 20+ and Rust, plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform:

```bash
npm install
```

```bash
npm run tauri build
```

For development, `npm run tauri dev` starts the app with hot reload. `npm run dev` alone serves the UI in a browser with generated sample data and a simulated WolfcamQL, which is enough for UI work.

## First run

1. Open **Settings**, set the WolfcamQL executable, and add your demo folders. If the status box reports missing paks, set the Quake Live folder and press **Sync paks**.
2. In **Library**, double-click a demo to play it. The **Player** view becomes the remote control.
3. Add clips from a kill, from the **Frag finder**, or with Mark in / Mark out. Render them in **Clips & render**.

## How it controls WolfcamQL

WolfcamQL has no remote-control interface, so WolfDeck uses what the engine provides. Everything it writes goes into a `wolfdeck` folder inside WolfcamQL's home `wolfcam-ql` folder.

- **Launch**: the command line only carries the home path, the demo and two `exec`s. The config profile and capture settings go into `wolfdeck/pre.cfg`, executed before the demo loads; start-up commands (seek, point of view, a profile's extra commands) go into `wolfdeck/session.cfg`, which runs once the demo has loaded. (The engine limits its command line to 1023 characters.)
- **Live commands**: each batch of commands is written to a small cfg file listed in `wolfdeck/cmd.cfg`, guarded by a sequence number so a batch runs exactly once. The engine is then told to execute `cmd.cfg`:
  - on Linux and macOS through the engine's command pipe (`com_pipefile`);
  - on Windows, where the engine has no pipe or stdin console, by posting a key press to the WolfcamQL window. WolfDeck binds that key (default F13, changeable in Settings) to `execq wolfdeck/cmd.cfg`.
- **Feedback**: WolfcamQL is started with `logfile 2`, and WolfDeck reads `qconsole.log`.
- **Renders**: a clip is recorded with the engine's own timed commands (`seekservertime`, `at <time> video …`, `at <time> stopvideo`, `at <time> quit`), using demo server times taken from WolfDeck's parser.

Things to know:

- WolfcamQL saves changed cvars and binds to its own `q3config.cfg` as usual, so profile settings, key binds set from the Keys view, the Windows control-key bind and `com_pipefile` persist there.
- The position shown in the Player is an estimate. It is exact after every seek made from WolfDeck; if you seek with WolfcamQL's own keys, press **Sync position**.
- On Windows, live commands do not arrive while WolfcamQL's console or a menu is open, because the engine does not run key binds then.
- While its window is focused, WolfcamQL captures the mouse. Alt-Tab back to WolfDeck, or use **Mouse capture** in the Player to turn that off.

## Status and testing

- The Rust backend has unit tests, plus parser tests against an excerpt of a real Quake Live demo. Kill counts and match start/end times were compared with WolfcamQL's own demo pre-parse on full demos (protocols 68 and 73).
- `src-tauri/tests/engine.rs` drives a real WolfcamQL: live command delivery (each batch exactly once), seeking by server time, capture and ffmpeg encode, camera points (add, undo, edit, path type), looping, demo cutting, screenshots, a custom HUD, a video restart mid-demo, and key binds (applied at launch, changed while running, triggered by a real key press, read back from the engine's config). It was run on Linux against WolfcamQL 12.7test53 built from source. It is skipped unless the `WOLFDECK_TEST_*` variables described in that file are set.
- Not yet verified on real hardware: the Windows key-press command channel (it compiles in CI, but has not been exercised against WolfcamQL on Windows), macOS, and demos of protocol 90 and 91 (the field tables follow the WolfcamQL source, but no sample demos were available).

## Licence

GPL-2.0-or-later. The demo decoding tables (network fields and the Huffman table) are derived from the ioquake3 / WolfcamQL source, which is GPL. The test fixture `src-tauri/tests/fixtures/ffa-excerpt.dm_73` is the first minute of a sample demo distributed with WolfcamQL.

WolfDeck is not affiliated with WolfcamQL, Wolf Whisperer, or id Software.
