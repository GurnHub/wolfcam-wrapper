// Catalog of WolfcamQL settings exposed in the Config view. Names and
// defaults were checked against the WolfcamQL source; anything not listed
// here can still be set through a profile's "extra commands".

export type CvarKind =
  | { type: "bool" }
  | { type: "range"; min: number; max: number; step: number }
  | { type: "select"; options: [string, string][] }
  | { type: "color" }
  | { type: "text" };

export interface CvarDef {
  name: string;
  label: string;
  help?: string;
  def: string;
  kind: CvarKind;
}

export interface CvarGroup {
  id: string;
  title: string;
  items: CvarDef[];
  /** Short reference shown under the group title: [term, meaning]. */
  legend?: [string, string][];
}

/**
 * Cvars the engine latches: a changed value only takes effect after
 * `vid_restart`. Taken from the WolfcamQL source; the backend keeps the same
 * list in `session.rs`.
 */
const LATCHED = new Set([
  "cl_renderer", "r_mode", "r_customwidth", "r_customheight", "r_noborder", "r_picmip", "r_overbrightbits", "r_mapoverbrightbits",
  "r_intensity", "r_fullbright", "r_vertexlight", "r_greyscale", "r_mapgreyscale", "r_ext_multisample", "r_ext_max_anisotropy",
  "r_usefbo", "r_fboantialias", "r_enablepostprocess", "r_enablecolorcorrect", "r_swapinterval", "s_useopenal",
]);

export function needsRestart(name: string): boolean {
  return LATCHED.has(name.toLowerCase());
}

export const FRAG_TOKENS: [string, string][] = [
  ["%v", "victim name"], ["%V", "victim name without colours"], ["%k", "killer name"], ["%K", "killer name without colours"],
  ["%q", "old Q3 frag message (\"player ate player2's rocket\")"], ["%w", "weapon name"], ["%i", "weapon icon"],
  ["%A", "killer's accuracy, all weapons"], ["%a", "killer's accuracy with the kill weapon"],
  ["%D", "victim's accuracy, all weapons"], ["%d", "victim's accuracy with the last held weapon"],
  ["%c", "colour, e.g. %c0xff00ff"], ["%t", "victim's team colour"], ["%T", "killer's team colour"],
  ["%f", "victim's flag in team games"], ["%F", "killer's flag in team games"], ["%n", "victim's country flag"], ["%N", "killer's country flag"],
  ["%l", "victim's clan tag"], ["%L", "victim's clan tag without colours"], ["%x", "killer's clan tag"], ["%X", "killer's clan tag without colours"],
];

const bool = (name: string, label: string, def: string, help?: string): CvarDef => ({ name, label, def, help, kind: { type: "bool" } });
const range = (name: string, label: string, def: string, min: number, max: number, step: number, help?: string): CvarDef => ({
  name, label, def, help, kind: { type: "range", min, max, step },
});
const select = (name: string, label: string, def: string, options: [string, string][], help?: string): CvarDef => ({
  name, label, def, help, kind: { type: "select", options },
});
const color = (name: string, label: string, def: string, help?: string): CvarDef => ({ name, label, def, help, kind: { type: "color" } });
const text = (name: string, label: string, def: string, help?: string): CvarDef => ({ name, label, def, help, kind: { type: "text" } });

export const CVAR_GROUPS: CvarGroup[] = [
  {
    id: "view",
    title: "View",
    items: [
      range("cg_fov", "Field of view", "90", 60, 140, 1),
      range("cg_zoomFov", "Zoom field of view", "60", 10, 100, 1),
      bool("cg_thirdPerson", "Third person camera", "0"),
      range("cg_thirdPersonRange", "Third person distance", "80", 20, 400, 5),
      range("cg_thirdPersonAngle", "Third person angle", "0", 0, 359, 1),
      range("cg_drawGun", "Weapon model", "1", 0, 3, 1, "0 hides the weapon; 1-3 are the Quake Live display styles."),
      range("cg_kickScale", "Damage view kick", "0", 0, 1, 0.1),
      range("cg_freecam_speed", "Free camera speed", "400", 50, 2000, 50),
    ],
  },
  {
    id: "hud",
    title: "HUD",
    items: [
      bool("cg_draw2D", "Show HUD", "1", "Turn off for clean footage without any 2D elements."),
      text("cg_hudFiles", "HUD file", "ui/hud.txt", "HUD definition to load, relative to wolfcam-ql."),
      bool("cg_qlhud", "Quake Live style HUD", "1"),
      range("cg_drawCrosshair", "Crosshair", "5", 0, 20, 1, "0 hides the crosshair."),
      range("cg_crosshairSize", "Crosshair size", "32", 8, 96, 2),
      color("cg_crosshairColor", "Crosshair colour", "0xffffff"),
      range("cg_crosshairAlpha", "Crosshair opacity", "255", 0, 255, 5),
      bool("cg_drawCrosshairNames", "Names under crosshair", "1"),
      bool("cg_drawFPS", "FPS counter", "1"),
      bool("cg_drawSpeed", "Speed meter", "1"),
      bool("cg_lagometer", "Lagometer", "1"),
      bool("cg_drawTimer", "Level timer", "1"),
      select("cg_levelTimerDirection", "Timer direction", "0", [["0", "Counts up"], ["1", "Counts down"]]),
      bool("cg_drawStatus", "Health / armour / ammo", "1"),
      bool("cg_drawScores", "Scores", "1"),
      bool("cg_drawAttacker", "Attacker portrait", "1"),
      bool("cg_drawRewards", "Medals", "1"),
      bool("cg_drawTeamOverlay", "Team overlay", "1"),
      bool("cg_drawAmmoWarning", "Low ammo warning", "1"),
      bool("cg_drawCenterPrint", "Centre messages", "1"),
      bool("cg_drawClientItemTimer", "Item timers", "1"),
      range("cg_drawFollowing", "\"Following\" label", "1", 0, 2, 1, "2 always shows it, even for the demo taker."),
      range("cg_chatTime", "Chat display time (ms)", "5000", 0, 20000, 500),
      range("cg_obituaryTime", "Kill feed time (ms)", "3000", 0, 20000, 500),
    ],
  },
  {
    id: "kills",
    title: "Frag messages",
    legend: FRAG_TOKENS,
    items: [
      text("cg_drawFragMessageTokens", "Frag message", "You fragged %v", "Shown in the centre when the followed player gets a kill."),
      text("cg_obituaryTokens", "Kill feed line", "%k %i %v"),
      text("cg_drawFragMessageTeamTokens", "Team kill message", "You fragged %v, your teammate"),
      text("cg_drawFragMessageFreezeTokens", "Freeze message", "You froze %v"),
      text("cg_drawFragMessageFreezeTeamTokens", "Team freeze message", "You froze %v, your teammate"),
      text("cg_drawFragMessageThawTokens", "Thaw message", "You thawed %v"),
      range("cg_drawFragMessageAlpha", "Opacity", "255", 0, 255, 5),
      range("cg_drawFragMessageScale", "Scale", "0.25", 0.05, 1, 0.01),
      range("cg_drawFragMessageX", "X position", "320", 0, 640, 1, "On the 640x480 virtual screen."),
      range("cg_drawFragMessageY", "Y position", "120", 0, 480, 1),
      range("cg_drawFragMessageTime", "Display time (ms)", "3000", 0, 20000, 250),
      color("cg_drawFragMessageColor", "Colour", "0xffffff"),
    ],
  },
  {
    id: "players",
    title: "Players",
    items: [
      text("cg_enemyModel", "Enemy model", "keel/bright", "model/skin; empty keeps each player's own model."),
      color("cg_enemyHeadColor", "Enemy head colour", "0x2a8000"),
      color("cg_enemyTorsoColor", "Enemy torso colour", "0x2a8000"),
      color("cg_enemyLegsColor", "Enemy legs colour", "0x2a8000"),
      text("cg_teamModel", "Team model", "", "model/skin; empty keeps each player's own model."),
      color("cg_teamHeadColor", "Team head colour", "0xffffff"),
      bool("cg_drawPlayerNames", "Name tags above players", "0"),
      bool("cg_drawSprites", "Sprites above players", "1"),
      bool("cg_wh", "See players through walls", "0", "Handy for free camera work."),
      bool("cg_drawBBox", "Bounding boxes", "0"),
      bool("cg_noTaunt", "Mute taunts", "0"),
    ],
  },
  {
    id: "effects",
    title: "Effects",
    items: [
      range("cg_gibs", "Gibs", "15", 0, 50, 1),
      bool("cg_marks", "Wall marks", "1"),
      range("cg_brassTime", "Shell casing lifetime (ms)", "2500", 0, 10000, 250),
      range("cg_railTrailTime", "Rail trail time (ms)", "400", 100, 3000, 50),
      bool("cg_simpleItems", "Simple (2D) items", "0"),
      bool("cg_muzzleFlash", "Muzzle flash", "1"),
      bool("cg_impactSparks", "Impact sparks", "1"),
      range("cg_smokeRadius_RL", "Rocket smoke size", "64", 0, 128, 4),
      range("cg_smokeRadius_GL", "Grenade smoke size", "32", 0, 128, 4),
      bool("cg_lightningImpact", "Lightning impact", "1"),
      range("cg_trueLightning", "True lightning", "1.0", 0, 1, 0.05),
      range("cg_shadows", "Player shadows", "1", 0, 3, 1),
      range("cg_screenDamageAlpha", "Damage flash opacity", "200", 0, 255, 5),
      bool("cg_enableBreath", "Cold breath", "1"),
    ],
  },
  {
    id: "debug",
    title: "Entities and overlays",
    items: [
      range("cg_drawEntNumbers", "Show entity numbers", "0", 0, 3, 1, "1 labels rockets, grenades, items and players so they can be followed; 2 and 3 also show them through walls."),
      bool("cg_drawCameraPath", "Draw the camera path", "1"),
      range("cg_drawCameraPointInfo", "Camera point info", "1", 0, 3, 1),
      bool("cg_freecam_noclip", "Free camera passes through walls", "0"),
      range("cg_freecam_sensitivity", "Free camera mouse sensitivity", "0.1", 0.01, 1, 0.01),
    ],
  },
  {
    id: "graphics",
    title: "Graphics",
    items: [
      select("cl_renderer", "Renderer", "opengl1", [["opengl1", "OpenGL 1 (classic)"], ["opengl2", "OpenGL 2"]]),
      range("r_picmip", "Texture detail (picmip)", "0", 0, 16, 1, "0 is full detail; higher values blur textures."),
      range("r_gamma", "Gamma", "1", 0.5, 3, 0.05),
      range("r_overBrightBits", "Overbright bits", "1", 0, 2, 1),
      range("r_mapOverBrightBits", "Map overbright bits", "2", 0, 4, 1),
      range("r_intensity", "Texture intensity", "1", 1, 3, 0.1),
      range("r_contrast", "Contrast", "1.0", 0.5, 2, 0.05),
      range("r_greyscale", "Greyscale", "0", 0, 1, 0.05),
      range("r_mapGreyScale", "Greyscale map only", "0", 0, 1, 0.05),
      bool("r_fullbright", "Fullbright", "0"),
      bool("r_vertexLight", "Vertex lighting", "0"),
      bool("r_fastsky", "Flat sky", "0"),
      bool("r_dynamiclight", "Dynamic lights", "1"),
      bool("r_flares", "Light flares", "0"),
      select("r_ext_multisample", "Anti-aliasing (MSAA)", "0", [["0", "Off"], ["2", "2x"], ["4", "4x"], ["8", "8x"]]),
      select("r_ext_max_anisotropy", "Anisotropic filtering", "2", [["2", "2x"], ["4", "4x"], ["8", "8x"], ["16", "16x"]]),
      bool("r_useFbo", "Render to framebuffer object", "0", "Needed for bloom, colour correction and off-screen anti-aliasing."),
      select("r_fboAntiAlias", "Framebuffer anti-aliasing", "0", [["0", "Off"], ["2", "2x"], ["4", "4x"], ["8", "8x"]]),
      bool("r_enableBloom", "Bloom", "0"),
      range("r_BloomIntensity", "Bloom intensity", "0.750", 0, 3, 0.05),
      bool("r_enableColorCorrect", "Colour correction", "1"),
    ],
  },
  {
    id: "audio",
    title: "Audio",
    items: [
      range("s_volume", "Volume", "0.8", 0, 1, 0.05),
      range("s_musicvolume", "Music volume", "0", 0, 1, 0.05),
      range("s_announcerVolume", "Announcer volume", "1.0", 0, 1, 0.05),
      range("s_killBeepVolume", "Kill beep volume", "1.0", 0, 1, 0.05),
      range("cg_killBeep", "Kill beep sound", "7", 0, 8, 1, "0 turns the beep off."),
      range("cg_hitBeep", "Hit beep style", "2", 0, 3, 1),
      range("cg_ambientSounds", "Ambient sounds", "2", 0, 3, 1),
      bool("cg_audioAnnouncerRewards", "Announce medals", "1"),
    ],
  },
];

export const CVAR_INDEX: Record<string, CvarDef> = Object.fromEntries(CVAR_GROUPS.flatMap((g) => g.items.map((i) => [i.name, i])));

/** "0xrrggbb" (engine) <-> "#rrggbb" (colour input). */
export function toCss(hex: string): string {
  const m = /^(?:0x|#)?([0-9a-f]{6})$/i.exec(hex.trim());
  return m ? `#${m[1].toLowerCase()}` : "#ffffff";
}

export function toEngine(css: string): string {
  return "0x" + css.replace("#", "").toLowerCase();
}
