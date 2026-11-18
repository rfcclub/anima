import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { hotspotView, nameplatePosition, placeOfAgent, nextHotspotFocus, activeHotspotId, MAX_TOKENS, type HotspotFocus } from "../../src/ui/features/castle/lib/map-hotspot";
import { COMMON_ROOM_SPRITES, WING_SPRITES } from "../../src/ui/features/castle/lib/map-sprites";
import { WEST_WING_CHAMBERS } from "../../src/ui/features/castle/lib/west-wing-chambers";
import { EAST_WING_CHAMBERS } from "../../src/ui/features/castle/lib/east-wing-chambers";
import { MapHotspotLayer } from "../../src/ui/features/castle/components/MapHotspotLayer";
import { RegionLabels } from "../../src/ui/features/castle/components/RegionLabels";
import { WestWingChambers } from "../../src/ui/features/castle/components/WestWingChambers";
import { EastWingChambers } from "../../src/ui/features/castle/components/EastWingChambers";

const hall = COMMON_ROOM_SPRITES.find((s) => s.id === "hall")!;
const bruno = WEST_WING_CHAMBERS.find((s) => s.id === "bruno")!;
const sam = WEST_WING_CHAMBERS.find((s) => s.id === "sam")!;

/** Visible text: markup with tags (and therefore attributes) removed. */
const visibleText = (html: string) => html.replace(/<[^>]*>/g, " ");
const EMOJI = /\p{Extended_Pictographic}/u;

describe("hotspotView", () => {
  test("an empty common room has no tokens and says so", () => {
    const v = hotspotView({ sprite: hall, occupants: [] });
    expect(v.tokens).toEqual([]);
    expect(v.more).toBe(0);
    expect(v.home).toBe(false);
    expect(v.away).toBe(false);
    expect(v.status).toBe("Nobody here yet.");
    expect(v.label).toBe("Town Hall, Meeting · Colony. Nobody here yet.");
  });

  test(`shows at most ${MAX_TOKENS} tokens and counts the rest`, () => {
    const v = hotspotView({ sprite: hall, occupants: ["gus", "pia", "milo", "eli"] });
    expect(v.tokens.map((t) => t.agentId)).toEqual(["gus", "pia", "milo"]);
    expect(v.more).toBe(1);
    expect(v.status).toBe("Gus, Pia, Milo and Eli are here.");
  });

  test("a meeting or pulse activity marks the room as talking", () => {
    expect(hotspotView({ sprite: hall, occupants: ["gus"], activities: { gus: "meeting:m-1" } }).talking).toBe(true);
    expect(hotspotView({ sprite: hall, occupants: ["rhea"], activities: { rhea: "pulse:observe" } }).talking).toBe(true);
    expect(hotspotView({ sprite: hall, occupants: ["hana"], activities: { hana: "wandering" } }).talking).toBe(false);
  });

  test("a chamber whose owner is home lists the owner first, then guests", () => {
    const v = hotspotView({ sprite: bruno, ownerId: "bruno", occupants: ["kai", "bruno"] });
    expect(v.home).toBe(true);
    expect(v.away).toBe(false);
    expect(v.tokens).toEqual([{ agentId: "bruno", role: "owner" }, { agentId: "kai", role: "guest" }]);
    expect(v.status).toBe("Bruno and Kai are in the room.");
  });

  test("a chamber whose owner is home alone", () => {
    expect(hotspotView({ sprite: bruno, ownerId: "bruno", occupants: ["bruno"] }).status).toBe("Bruno is home.");
  });

  test("an empty chamber is away and says where the owner is", () => {
    const v = hotspotView({ sprite: sam, ownerId: "sam", occupants: [], ownerPlaceId: "chamber_milo" });
    expect(v.away).toBe(true);
    expect(v.home).toBe(false);
    expect(v.tokens).toEqual([]);
    expect(v.status).toBe("Sam is at Milo's Prism.");
  });

  test("an empty chamber with the owner nowhere known", () => {
    expect(hotspotView({ sprite: sam, ownerId: "sam", occupants: [], ownerPlaceId: null }).status).toBe("Sam is away.");
  });

  test("a chamber with guests but no owner is not dimmed, and still says where the owner is", () => {
    const v = hotspotView({ sprite: sam, ownerId: "sam", occupants: ["abel"], ownerPlaceId: "chamber_milo" });
    expect(v.away).toBe(false);
    expect(v.tokens).toEqual([{ agentId: "abel", role: "guest" }]);
    expect(v.status).toBe("Sam is at Milo's Prism · Abel is visiting.");
  });

  test("a chamber with guests and the owner nowhere known", () => {
    expect(hotspotView({ sprite: sam, ownerId: "sam", occupants: ["abel"], ownerPlaceId: null }).status).toBe("Sam is away · Abel is visiting.");
  });

  test("the status and accessible name say what is happening, not only who is there", () => {
    const idle = hotspotView({ sprite: hall, occupants: ["eli"] });
    const meeting = hotspotView({ sprite: hall, occupants: ["eli"], activities: { eli: "meeting:m-1" } });
    expect(idle.status).toBe("Eli is here.");
    expect(meeting.status).toBe("Eli is here. In a meeting.");
    expect(meeting.label).toBe("Town Hall, Meeting · Colony. Eli is here. In a meeting.");
    expect(hotspotView({ sprite: hall, occupants: ["rhea"], activities: { rhea: "pulse:observe" } }).status).toBe("Rhea is here. Running pulse-anima (observe).");
    expect(hotspotView({ sprite: hall, occupants: ["hana"], activities: { hana: "session:tech:s-1" } }).status).toBe("Hana is here. In session tech.");
    expect(hotspotView({ sprite: bruno, ownerId: "bruno", occupants: ["bruno", "kai"], activities: { bruno: "meeting:m-2", kai: "meeting:m-2" } }).status)
      .toBe("Bruno and Kai are in the room. In a meeting.");
  });
});

describe("hover and keyboard focus", () => {
  const run = (events: Array<Parameters<typeof nextHotspotFocus>[1]>) =>
    events.reduce<HotspotFocus>((s, e) => nextHotspotFocus(s, e), { hover: null, focus: null });

  test("leaving a hovered building returns the light to the focused one", () => {
    const s = run([{ type: "focus", id: "hall" }, { type: "enter", id: "library" }, { type: "leave", id: "library" }]);
    expect(activeHotspotId(s)).toBe("hall");
  });

  test("hover wins while the pointer is over a building", () => {
    expect(activeHotspotId(run([{ type: "focus", id: "hall" }, { type: "enter", id: "library" }]))).toBe("library");
  });

  test("blur clears focus but not hover; a stale leave does nothing", () => {
    expect(activeHotspotId(run([{ type: "enter", id: "forge" }, { type: "focus", id: "hall" }, { type: "blur", id: "hall" }]))).toBe("forge");
    expect(activeHotspotId(run([{ type: "enter", id: "forge" }, { type: "leave", id: "hall" }]))).toBe("forge");
    expect(activeHotspotId(run([{ type: "focus", id: "hall" }, { type: "blur", id: "hall" }]))).toBeNull();
  });
});

describe("nameplatePosition", () => {
  const size = { width: 300, height: 240 };
  test("goes to the right of a building when there is room", () => {
    expect(nameplatePosition({ left: 340, top: 95, width: 300, height: 230 }, size)).toEqual({ left: 664, top: 95 });
  });
  test("goes to the left near the right edge", () => {
    expect(nameplatePosition({ left: 1520, top: 660, width: 260, height: 260 }, size)).toEqual({ left: 1196, top: 660 });
  });
  test("stays inside the map vertically", () => {
    expect(nameplatePosition({ left: 100, top: 1000, width: 100, height: 60 }, size).top).toBe(1080 - 240 - 16);
    expect(nameplatePosition({ left: 100, top: -40, width: 100, height: 60 }, size).top).toBe(16);
  });
});

describe("placeOfAgent", () => {
  test("finds the place an agent is in, or null", () => {
    const presence = { chamber_milo: ["milo", "sam"], library: ["rhea"] };
    expect(placeOfAgent(presence, "sam")).toBe("chamber_milo");
    expect(placeOfAgent(presence, "bruno")).toBeNull();
  });
});

describe("MapHotspotLayer", () => {
  const html = renderToStaticMarkup(
    <MapHotspotLayer
      attr="data-chamber"
      presence={{ chamber_bruno: ["bruno"], chamber_milo: ["milo", "sam"] }}
      activities={{}}
      items={WEST_WING_CHAMBERS.map((c) => ({ sprite: c, ownerId: c.id, placeIds: [`chamber_${c.id}`], onClick: () => {} }))}
    />,
  );

  test("each hotspot is a button named by place, people and activity", () => {
    expect((html.match(/<button/g) ?? []).length).toBe(8);
    expect(html).toContain('data-chamber="bruno"');
    expect(html).toContain('aria-label="Bruno&#x27;s Garden, Private · Philosophy. Bruno is home."');
    expect(html).toContain('aria-label="Sam&#x27;s Forge, Build · Create. Sam is at Milo&#x27;s Prism."');
  });

  test("draws no colored box, emoji or text label at rest", () => {
    for (const c of WEST_WING_CHAMBERS) expect(html).not.toContain(c.color);
    expect(visibleText(html)).not.toMatch(EMOJI);
    for (const c of WEST_WING_CHAMBERS) expect(visibleText(html)).not.toContain(c.label);
  });

  test("the only images drawn are occupant portraits", () => {
    const srcs = [...html.matchAll(/<img[^>]*src="([^"]*)"/g)].map((m) => m[1]);
    expect(srcs.length).toBe(3);
    for (const src of srcs) expect(src).toMatch(/^\/api\/vn\/portrait\//);
  });

  test("keeps a visible focus ring and leaves naming to the button", () => {
    // Tailwind v4 `outline-none` sets outline-style: none, which a width-only focus class cannot undo.
    expect(html).not.toMatch(/[\s"]outline-none[\s"]/);
    expect(html).not.toContain("focus:outline-none");
    for (const c of ["focus-visible:outline-solid", "focus-visible:outline-2", "focus-visible:outline-castle-lantern"]) expect(html).toContain(c);
  });

  test("marks home and away chambers and shows tokens", () => {
    expect((html.match(/castle-home-glow/g) ?? []).length).toBe(2);
    // 8 chambers: bruno and milo are home, the other 6 are empty.
    expect((html.match(/castle-away-veil/g) ?? []).length).toBe(6);
    expect((html.match(/data-token=/g) ?? []).length).toBe(3);
  });
});

describe("the three maps use the lantern hotspots", () => {
  const maps = [
    { name: "common rooms", html: renderToStaticMarkup(<RegionLabels />), sprites: [...COMMON_ROOM_SPRITES, ...WING_SPRITES], attrs: ["data-room", "data-wing"] },
    { name: "west wing", html: renderToStaticMarkup(<WestWingChambers />), sprites: WEST_WING_CHAMBERS, attrs: ["data-chamber"] },
    { name: "east wing", html: renderToStaticMarkup(<EastWingChambers />), sprites: EAST_WING_CHAMBERS, attrs: ["data-chamber"] },
  ];
  for (const m of maps) {
    test(`${m.name}: one button per hotspot, no colored box, no icon, no label`, () => {
      for (const s of m.sprites) {
        expect(m.html).toMatch(new RegExp(`<button[^>]*(${m.attrs.join("|")})="${s.id}"`));
        expect(m.html).not.toContain(s.color);
      }
      expect(m.html).not.toContain("/api/vn/asset-file/icons/");
      const text = visibleText(m.html.replace(/<button[^>]*data-nav[\s\S]*?<\/button>/g, ""));
      expect(text).not.toMatch(EMOJI);
    });
  }
});
