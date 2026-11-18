/**
 * Room stage — Pixi'VN canvas for a single agent room (or common room with
 * several agents present). Canvas renders visuals only (background +
 * character portraits as sprites); UI (name, chat bubble, log, input) is
 * React, mounted the same way as MainScreen/WestWingScreen/EastWingScreen
 * via bootStage/clearStage. Real image textures this time, not placeholder
 * color rects — falls back to a colored rect per character/background when
 * the asset doesn't exist yet (for example, placeholder characters can simply be
 * shown as rectangles).
 */
import { canvas, Container, Sprite, Text, Texture, TickerBase, tickerDecorator, type TickerValue } from "@drincs/pixi-vn";
import { backgroundUrl, portraitUrl } from "../../../lib/vn-assets";
import { MAP_HEIGHT, MAP_WIDTH } from "./pixi-stage";
import { OWNER_PORTRAIT_HEIGHT_FACTOR, OWNER_PORTRAIT_XALIGN, OWNER_PORTRAIT_YFACTOR, PORTRAIT_CHAIN } from "../lib/stage-layout";

// Portrait placement constants live in lib/stage-layout.ts, shared with the chat bubble layout.
export { OWNER_PORTRAIT_XALIGN };

export type Position = "left" | "center-left" | "center" | "center-right" | "right";

export interface RoomCharacter {
  agentId: string;
  position: Position;
  emotion: string;
  /** Briefly true right after the user clicks this occupant in the
   *  addressee rail. Renders a warm additive glow behind the sprite as
   *  feedback — v1 has no tween/movement animation, the
   *  glow is the primary selection cue. RoomScreen clears it via a short
   *  setTimeout after the reorder. */
  highlighted?: boolean;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  speaker?: string;
  ts?: number;
}

const XALIGN: Record<Position, number> = {
  left: 0.12,
  "center-left": 0.31,
  center: 0.5,
  "center-right": 0.69,
  right: 0.94,
};

export function positionToXAlign(position: Position | undefined): number {
  if (!position) return 0.5;
  return XALIGN[position] ?? 0.5;
}
// Deterministic placeholder color per agent, for when a portrait/background
// asset doesn't exist yet — not random, so the same agent always gets the
// same color across renders.
function placeholderColor(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return 0x333333 + (hash % 0x999999);
}

type TextureLike = ReturnType<typeof Texture.from>;

/**
 * Load an image texture from a URL. The VN asset URLs (/api/vn/background/:id,
 * /api/vn/portrait/:agent/:emotion) have NO file extension, so Pixi's
 * Assets.load can't infer the image parser ("don't know how to parse it").
 * Loading via an HTMLImageElement bypasses the parser — the browser decodes
 * the image from the response content-type, then Texture.from wraps it.
 */
async function loadTextureOrNull(url: string): Promise<TextureLike | null> {
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`image load failed: ${url}`));
      img.src = url;
    });
    const tex = Texture.from(img);
    return tex;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[vn] FAILED to load texture: ${url}`, err);
    return null;
  }
}

const BG_ALIAS = "room-bg";
// Visitor portrait scale — enlarged (was 0.42). Owner portrait is
// sized by canvas height below (HEIGHT_FACTOR), not this scale.
const PORTRAIT_SCALE = 0.6;
// X position (as fraction of canvas width) for the owner portrait rendered
// in the left panel. Visitors stay near center-right of the scene.
// X position (as fraction of canvas width) for the owner portrait. With
// HEIGHT_FACTOR 0.62 the owner sprite is ~502px wide on a 1920 canvas, so
// XALIGN must keep its left edge on-screen: leftX = center - width/2 ≥ 0 →
// center ≥ 251 → XALIGN ≥ 0.13. 0.13 parks the owner flush to the left edge.
// Owner portrait sits flush to the bottom of the screen (anchor baseline at
// MAP_HEIGHT) — was 0.5 (vertical middle).
// Owner portrait height as a fraction of canvas height — enlarged
// (was 0.46). Sized by height so it's resolution-independent and always
// spans ~62% of screen height from the bottom up.

export async function renderRoomBackground(sceneId: string): Promise<void> {
  const texture = await loadTextureOrNull(backgroundUrl(sceneId));
  const sprite = texture ? new Sprite(texture) : new Sprite(Texture.WHITE);
  if (!texture) sprite.tint = placeholderColor(sceneId);
  sprite.width = MAP_WIDTH;
  sprite.height = MAP_HEIGHT;
  canvas.add(BG_ALIAS, sprite);
}

const charAlias = (agentId: string) => `room-char-${agentId}`;

/**
 * Compute + cache the owner portrait's rendered width + X WITHOUT adding it
 * to the canvas. Visitors positioned at "right" need ownerWidth to place
 * leftX = brunoLeftX + ownerWidth/1.2 (which overlaps the owner). The owner is
 * rendered AFTER the visitors so it draws on top (Pixi: later add = upper),
 * hiding the overlap. This primes lastOwnerWidth/lastOwnerX in advance.
 */
export async function renderRoomCharacters(
  characters: RoomCharacter[],
  firstXAlign: number = OWNER_PORTRAIT_XALIGN,
  heightFactor: number = OWNER_PORTRAIT_HEIGHT_FACTOR,
  yFactor: number = OWNER_PORTRAIT_YFACTOR,
): Promise<string[]> {
  // Build the stage from an ordered agents[] list. agents[0] anchors at
  // `firstXAlign` (defaults to OWNER_PORTRAIT_XALIGN — RoomScreen.tsx's
  // chamber layout, where agents[0] is the owner or, when away, the first
  // visitor). Common rooms have no owner concept and a wide symmetric
  // background, not a left-anchored dialogue box — PublicRoomPage.tsx
  // passes 0.5 (center) instead (the fixed 0.13 left-bias left a wide room
  // looking empty).
  // Each subsequent agent chains off the previous:
  //   x[n] = x[n-1] + 0.82 * width[n-1]
  // Sprites use anchor (0.5, 1) — x is the CENTER — so the
  // chain is computed in center-x space: next center = prev center +
  // 0.82 * prev width. This replaces the old lastOwnerWidth/position logic,
  // which mis-placed visitors when the owner was absent (no anchor to key
  // off) and crashed the room to black.
  let prevCenterX = 0;
  let prevWidth = 0;
  // Ids whose portrait could not be loaded and got a placeholder; the caller (lib/stage-sync.ts) draws them again later.
  const failed: string[] = [];
  for (let i = 0; i < characters.length; i++) {
    const c = characters[i];
    const texture = await loadTextureOrNull(portraitUrl(c.agentId, c.emotion));
    if (!texture) failed.push(c.agentId);
    const sprite = texture ? new Sprite(texture) : new Sprite(Texture.WHITE);
    const targetHeight = MAP_HEIGHT * heightFactor;
    if (!texture) {
      sprite.tint = placeholderColor(c.agentId);
      sprite.height = targetHeight;
      sprite.width = targetHeight * (320 / 480);
    } else {
      // Size by canvas height so every portrait shares the same height
      // regardless of source resolution.
      const srcHeight = (sprite.texture?.frame?.height as number | undefined) ?? MAP_HEIGHT;
      const scale = srcHeight > 0 ? targetHeight / srcHeight : 1;
      sprite.scale.set(scale);
    }
    sprite.anchor.set(0.5, 1);
    if (i === 0) {
      sprite.x = MAP_WIDTH * firstXAlign;
      sprite.y = MAP_HEIGHT * yFactor;
    } else {
      sprite.x = prevCenterX + PORTRAIT_CHAIN * prevWidth;
      sprite.y = MAP_HEIGHT * yFactor;
    }
    prevCenterX = sprite.x;
    prevWidth = sprite.width;
    if (c.highlighted) {
      try {
        const glow = new Sprite(Texture.WHITE);
        glow.tint = 0xe8d8b0; // castle cream
        glow.alpha = 0.35;
        glow.anchor.set(0.5, 1);
        glow.x = sprite.x;
        glow.y = sprite.y;
        glow.width = sprite.width * 1.18;
        glow.height = sprite.height * 1.06;
        glow.blendMode = "add";
        canvas.add(glowAlias(c.agentId), glow);
      } catch {
        // Blend-mode/glow is cosmetic — never let it break the room render.
      }
    }
    canvas.add(charAlias(c.agentId), sprite);
  }
  return failed;
}

const glowAlias = (agentId: string) => `${charAlias(agentId)}-glow`;

// --- Breathing (waiting-for-reply) animation ---
// Character animation while a reply is in flight —
// a subtle vertical bob on the speaking portrait, not a Pixi sprite swap.
// canvas.addTicker/removeTicker is this installed version's (1.8.22)
// ticker API — the newer canvas.tickers.* namespace seen in current docs
// isn't shipped yet. Tracks the running ticker's own id per alias (not
// the class) so stopping removes exactly this ticker via removeTicker,
// without the deprecated class-based unlinkComponentFromTicker's type
// mismatch (BreathTicker's constructor isn't zero-arg).
const BREATH_AMPLITUDE_PX = 3;
const BREATH_PERIOD_MS = 1800;
const breathTickerIds = new Map<string, string>();

@tickerDecorator()
class BreathTicker extends TickerBase<{ baseY: number }> {
  override fn(t: TickerValue, args: { baseY: number }, aliases: string[]): void {
    for (const alias of aliases) {
      const sprite = canvas.find<Sprite>(alias);
      if (sprite) sprite.y = args.baseY + Math.sin(t.elapsedMS / BREATH_PERIOD_MS * Math.PI * 2) * BREATH_AMPLITUDE_PX;
    }
  }
}

/** Start/stop the breathing bob on a character's portrait. Safe to call
 *  even if the sprite isn't on stage (e.g. the agent hasn't rendered yet,
 *  or already left) — a missing alias is a silent no-op each frame. */
export function setPortraitBreathing(agentId: string, active: boolean): void {
  // Defensive per the established pattern in this file (glow sprite,
  // above): this can run before Game.init()/the sprite exists (React
  // effect order isn't guaranteed relative to the async renderRoomBackground
  // /renderRoomCharacters effect), and canvas.find/addTicker throw if the
  // canvas isn't initialized yet. Cosmetic animation must never blacken
  // the room over a race it doesn't need to win.
  try {
    const alias = charAlias(agentId);
    if (active) {
      const sprite = canvas.find<Sprite>(alias);
      const id = canvas.addTicker(alias, new BreathTicker({ baseY: sprite?.y ?? MAP_HEIGHT * OWNER_PORTRAIT_YFACTOR }));
      if (id) breathTickerIds.set(alias, id);
    } else {
      const id = breathTickerIds.get(alias);
      if (id) {
        canvas.removeTicker(id);
        breathTickerIds.delete(alias);
      }
      const sprite = canvas.find<Sprite>(alias);
      if (sprite) sprite.y = MAP_HEIGHT * OWNER_PORTRAIT_YFACTOR;
    }
  } catch {
    // Canvas not ready, or a transient Pixi state issue — skip this call.
  }
}

export function removeRoomCharacter(agentId: string): void {
  canvas.remove(charAlias(agentId));
  try {
    canvas.remove(glowAlias(agentId));
  } catch {
    // not present — ignore.
  }
}

// --- Chat log (Pixi-rendered, sits behind the React dialog/input boxes) ---
// Requirement: the chat log must be Pixi-rendered so it lives in the canvas
// z-order BELOW the HTML-layer dialog box + input. The React overlay (dialog,
// input, toggle) draws on top of it.
const CHATLOG_ALIAS = "room-chatlog";

function formatTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Render (or re-render) the chat log as Pixi Text lines inside a Container
 * pinned to the bottom of the canvas, spanning the width between the left
 * agent panel and the right edge. Because it's canvas, the HTML-layer dialog
 * box and input render on top of it.
 *
 * Alignment: the chat log's left edge MUST match the dialogue box + input box
 * (both HTML, left: 24%). Requirement: the chat log's left X must equal the dialogue
 * and input box left X — otherwise the log sits flush-left while the
 * dialog/input float mid-canvas, looking disjointed.
 */
export function renderRoomChatLog(turns: ChatTurn[]): void {
  // The canvas may not be bootstrapped yet (Game.init is async). If this runs
  // before boot, canvas.add throws "[Pixi'VN] CanvasManagerStatic.app is
  // undefined" — swallowing that keeps the RoomScreen from crashing to a
  // black screen. The effect re-runs once booted.
  try {
    // Remove previous render first (idempotent re-render on new turns).
    try {
      canvas.remove(CHATLOG_ALIAS);
    } catch {
      // alias not present yet — ignore.
    }

    const container = new Container();
    // Left edge aligned with the dialogue/input boxes (left: 24% in HTML).
    // Right edge at ~68% to match the boxes' right: 32% when the log is shown.
    const leftX = MAP_WIDTH * 0.24;
    const rightX = MAP_WIDTH * 0.68;
    const logWidth = rightX - leftX;
    // Bottom strip behind dialog/input. Starts low enough that the dialog box
    // (React, bottom: 80) and input (React, bottom: 16) sit visually on top.
    const lineHeight = 26;
    const visibleTurns = turns.slice(-20); // keep last 20 for performance
    let y = MAP_HEIGHT - 200;
    for (const t of visibleTurns) {
      const speaker = t.speaker ?? (t.role === "user" ? "You" : "");
      const time = formatTime(t.ts);
      const line = new Text({
        text: `${time ? `[${time}] ` : ""}${speaker}: ${t.content}`,
        style: {
          fontFamily: "monospace",
          fontSize: 18,
          fill: 0xd8c8a8,
          wordWrap: true,
          wordWrapWidth: logWidth,
        },
      });
      line.x = leftX;
      line.y = y;
      line.anchor.set(0, 0);
      container.addChild(line);
      y -= lineHeight;
    }
    canvas.add(CHATLOG_ALIAS, container);
  } catch {
    // Canvas not ready yet — the effect re-runs when turns change / canvas boots.
  }
}

export function removeRoomChatLog(): void {
  try {
    canvas.remove(CHATLOG_ALIAS);
  } catch {
    // not present — ignore.
  }
}

// --- Agent panel (Pixi-rendered) ---
// Requirement: the left panel must be Pixi-rendered (not React HTML) so it
// matches the chat log's render layer — a React HTML panel next to a Pixi
// chat log looked visually inconsistent (mismatched columns). Drawing it as a Pixi Graphics rect + Text keeps both columns
// in the same canvas z-order.
const PANEL_ALIAS = "room-panel";

export function renderRoomAgentPanel(agentName: string): void {
  try {
    try {
      canvas.remove(PANEL_ALIAS);
    } catch {
      // not present yet — ignore.
    }

    const container = new Container();
    const panelWidth = MAP_WIDTH * 0.22;

    // Panel background — solid dark, drawn as a tinted white-texture sprite
    // (pixi-vn doesn't re-export Graphics, so we use the same Sprite approach
    // as the background renderer).
    const bg = new Sprite(Texture.WHITE);
    bg.tint = 0x1a1410;
    bg.width = panelWidth;
    bg.height = MAP_HEIGHT;
    container.addChild(bg);

    // Right border accent.
    const border = new Sprite(Texture.WHITE);
    border.tint = 0xe8d8b0;
    border.alpha = 0.33;
    border.width = 2;
    border.height = MAP_HEIGHT;
    border.x = panelWidth - 2;
    container.addChild(border);

    // Agent name at the top of the panel.
    const name = new Text({
      text: agentName,
      style: {
        fontFamily: "monospace",
        fontSize: 22,
        fontWeight: "bold",
        fill: 0xe8d8b0,
        letterSpacing: 3,
        align: "center",
      },
    });
    name.anchor.set(0.5, 0);
    name.x = panelWidth / 2;
    name.y = 24;
    container.addChild(name);

    canvas.add(PANEL_ALIAS, container);
  } catch {
    // Canvas not ready yet.
  }
}

export function removeRoomAgentPanel(): void {
  try {
    canvas.remove(PANEL_ALIAS);
  } catch {
    // not present — ignore.
  }
}

// --- Dialogue box (Pixi-rendered) ---
// Requirement: the dialogue box must be Pixi-rendered to match the panel +
// chat log layer. Only the input box stays React HTML (needs textarea
// typing/focus). The dialogue sits bottom-center, left 24% / right 32% to
// match the input box width.
const DIALOGUE_ALIAS = "room-dialogue";

export function renderRoomDialogue(speaker: string, text: string): void {
  if (!text) {
    removeRoomDialogue();
    return;
  }
  try {
    try {
      canvas.remove(DIALOGUE_ALIAS);
    } catch {
      // not present yet — ignore.
    }

    const container = new Container();
    const leftX = MAP_WIDTH * 0.24;
    const rightX = MAP_WIDTH * 0.68;
    const boxWidth = rightX - leftX;
    // bottom: 80 (React px) → canvas y from top. Box height ~140 for speaker + text.
    const boxHeight = 140;
    const boxY = MAP_HEIGHT - 80 - boxHeight;

    // Box background (tinted sprite, no Graphics available from pixi-vn).
    const bg = new Sprite(Texture.WHITE);
    bg.tint = 0x241c14;
    bg.alpha = 0.93;
    bg.width = boxWidth;
    bg.height = boxHeight;
    bg.x = leftX;
    bg.y = boxY;
    container.addChild(bg);

    // Border (top/bottom/left/right rects).
    const borderColor = 0xe8d8b0;
    const mkBorder = (x: number, y: number, w: number, h: number) => {
      const s = new Sprite(Texture.WHITE);
      s.tint = borderColor;
      s.width = w;
      s.height = h;
      s.x = x;
      s.y = y;
      container.addChild(s);
    };
    mkBorder(leftX, boxY, boxWidth, 2); // top
    mkBorder(leftX, boxY + boxHeight - 2, boxWidth, 2); // bottom
    mkBorder(leftX, boxY, 2, boxHeight); // left
    mkBorder(leftX + boxWidth - 2, boxY, 2, boxHeight); // right

    // Speaker label.
    const speakerText = new Text({
      text: speaker,
      style: {
        fontFamily: "monospace",
        fontSize: 20,
        fontWeight: "bold",
        fill: 0xe8d8b0,
        letterSpacing: 1,
      },
    });
    speakerText.x = leftX + 24;
    speakerText.y = boxY + 16;
    container.addChild(speakerText);

    // Dialogue body — word-wrapped to the box width.
    const body = new Text({
      text,
      style: {
        fontFamily: "monospace",
        fontSize: 20,
        fill: 0xf0e6d2,
        wordWrap: true,
        wordWrapWidth: boxWidth - 48,
        lineHeight: 29,
      },
    });
    body.x = leftX + 24;
    body.y = boxY + 48;
    container.addChild(body);

    canvas.add(DIALOGUE_ALIAS, container);
  } catch {
    // Canvas not ready yet.
  }
}

export function removeRoomDialogue(): void {
  try {
    canvas.remove(DIALOGUE_ALIAS);
  } catch {
    // not present — ignore.
  }
}
