import { useState, useEffect, useCallback, useRef } from "react";
import { COMMON_ROOM_SPRITES, WING_SPRITES } from "../../castle/lib/map-sprites";
import { PUBLIC_SPRITE_TO_PLACE } from "../../castle/lib/place-labels";
import { WEST_WING_CHAMBERS } from "../../castle/lib/west-wing-chambers";
import { EAST_WING_CHAMBERS } from "../../castle/lib/east-wing-chambers";

const AGENTS = ["bruno", "eli", "cleo", "lena", "milo", "sam", "abel", "finn", "gus", "hana", "nora", "pia", "rhea", "ivan", "dana", "kai"];
// Derived from COMMON_ROOM_SPRITES/PUBLIC_SPRITE_TO_PLACE (not hand-listed) so
// the background upload options can't drift from the actual common-room
// placeIds the castle map and PublicRoomPage resolve backgrounds by.
const COMMON_ROOM_SCENES = COMMON_ROOM_SPRITES.map((s) => ({
  id: PUBLIC_SPRITE_TO_PLACE[s.id] ?? s.id,
  label: s.label,
}));
const SHARED_SCENES = [
  { id: "castle_common", label: "Common / Great Hall" },
  { id: "castle_west", label: "West Wing" },
  { id: "castle_east", label: "East Wing" },
  ...COMMON_ROOM_SCENES,
];
// Every clickable marker on the castle map, by the ids the map uses. The map
// stopped drawing these icons in castle-lantern-hotspots (the painting carries
// each building); uploads here are kept but not shown on the map.
const ROOM_ICONS = [...WING_SPRITES, ...COMMON_ROOM_SPRITES, ...WEST_WING_CHAMBERS, ...EAST_WING_CHAMBERS].map((s) => ({ id: s.id, label: s.label }));
const IMAGE_EXTS = ["png", "webp", "jpg", "jpeg", "gif"];
const ELLIPSIS_STYLE: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

interface AssetsData {
  portraits: string[];
  backgrounds: string[];
  icons: string[];
  bgm: string[];
  sfx: string[];
}

type AssetType = "portraits" | "backgrounds" | "icons" | "bgm" | "sfx";
type Tab = "portraits" | "backgrounds" | "icons" | "audio" | "upload";

function portraitUrl(f: string): string {
  const parts = f.split("/");
  const fname = parts.pop() ?? f;
  const baseName = fname.replace(/\.[^.]+$/, "");
  const agent = parts.length > 0 ? parts[0] : baseName;
  const emotion = parts.length > 0 ? baseName : "neutral";
  return "/api/vn/portrait/" + agent + "/" + emotion;
}

export function VnAssetsPage() {
  const [assets, setAssets] = useState<AssetsData>({ portraits: [], backgrounds: [], icons: [], bgm: [], sfx: [] });
  const [filter, setFilter] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("portraits");
  const [uploadType, setUploadType] = useState<AssetType>("portraits");
  const [uploadAgent, setUploadAgent] = useState("");
  const [uploadScene, setUploadScene] = useState("");
  const [uploadRoom, setUploadRoom] = useState("");
  const [uploadEmotion, setUploadEmotion] = useState("");
  const [uploadStatus, setUploadStatus] = useState<{ cls: string; msg: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const loadAssets = useCallback(async () => {
    try {
      const r = await fetch("/api/vn/assets");
      const d = (await r.json()) as AssetsData;
      setAssets(d);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadAssets(); }, [loadAssets]);

  const removeAsset = useCallback(async (type: string, filename: string) => {
    if (!window.confirm("Remove " + filename + "?")) return;
    try {
      await fetch("/api/vn/assets/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, filename }),
      });
      loadAssets();
    } catch { /* ignore */ }
  }, [loadAssets]);

  const uploadAsset = useCallback(async () => {
    const fileInput = fileInputRef.current;
    if (!fileInput?.files?.[0]) { setUploadStatus({ cls: "err", msg: "Select a file first" }); return; }
    const form = new FormData();
    form.append("file", fileInput.files[0]);
    form.append("type", uploadType);
    if (uploadType === "backgrounds" && uploadScene) form.append("scene", uploadScene);
    else if (uploadType === "icons") { if (uploadRoom) form.append("room", uploadRoom); }
    else if (uploadAgent) form.append("agent", uploadAgent);
    if (uploadEmotion.trim()) form.append("emotion", uploadEmotion.trim());

    setUploadStatus({ cls: "info", msg: "Uploading..." });
    try {
      const r = await fetch("/api/vn/assets/upload", { method: "POST", body: form });
      const d = (await r.json()) as { ok?: boolean; path?: string; error?: string };
      if (d.ok) {
        setUploadStatus({ cls: "ok", msg: "Uploaded: " + d.path });
        loadAssets();
      } else {
        setUploadStatus({ cls: "err", msg: "Error: " + (d.error || "unknown") });
      }
    } catch (e) {
      setUploadStatus({ cls: "err", msg: "Upload failed: " + (e as Error).message });
    }
  }, [uploadType, uploadAgent, uploadScene, uploadRoom, uploadEmotion, loadAssets]);

  function renderGrid(files: string[], type: AssetType, useFilter?: boolean) {
    let filtered = files;
    if (useFilter && filter) filtered = files.filter((f) => f.toLowerCase().startsWith(filter.toLowerCase()));
    if (filtered.length === 0) {
      return <div className="text-center text-[#6a5e48] py-10 text-[15px]">{filter ? "No assets for " + filter + ". Upload some!" : "No assets yet. Upload some!"}</div>;
    }
    return filtered.map((f) => {
      const ext = f.split(".").pop()?.toLowerCase() ?? "";
      const isImage = IMAGE_EXTS.includes(ext);
      return (
        <div key={f} className="bg-[#2a2218] border border-[#3a2e1e] rounded-lg p-3 flex flex-col">
          <div className="w-full h-[180px] flex items-center justify-center bg-black/30 rounded">
            {isImage ? (
              <img src={type === "portraits" ? portraitUrl(f) : "/api/vn/asset-file/" + type + "/" + f} className="w-full h-[180px] object-contain" alt={f} />
            ) : (
              <span className="text-4xl">{ext === "ogg" ? "🎵" : "🎬"}</span>
            )}
          </div>
          <div className="text-[13px] text-[#d4c09a] mt-2" style={ELLIPSIS_STYLE} title={f}>{f}</div>
          <div className="flex gap-1 mt-1.5">
            <button onClick={() => removeAsset(type, f)} className="text-[12px] px-2.5 py-1 rounded bg-red-900/50 text-red-300 hover:bg-red-800/60">Remove</button>
          </div>
        </div>
      );
    });
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "portraits", label: "Portraits" },
    { id: "backgrounds", label: "Backgrounds" },
    { id: "icons", label: "Room Icons" },
    { id: "audio", label: "Audio" },
    { id: "upload", label: "Upload" },
  ];

  return (
    <div className="min-h-screen bg-[#1a1208] text-[#d4c09a] p-8" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
    <div className="max-w-[1800px] mx-auto">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl text-[#e4c76b] font-semibold">🎨 VN Assets</h1>
        <div className="flex gap-4">
          <a href="/castle" className="text-[13px] text-[#7a5c30] hover:text-[#e4c76b]">◂ Castle</a>
          <a href="/" className="text-[13px] text-[#7a5c30] hover:text-[#e4c76b]">◂ Town</a>
        </div>
      </div>

      <div className="bg-[#2a2218] border border-[#3a2e1e] rounded-lg px-4 py-3 mb-4 leading-relaxed">
        <h3 className="text-[13px] text-[#e4c76b] font-semibold mb-1.5">📖 How to Customize the Visual Novel</h3>
        <p className="text-[13px] text-[#a09080]">Drop images below to customize agent portraits, room backgrounds, and map icons. The VN stage and castle map load them automatically.</p>
        <p className="mt-2 text-[12px] text-[#6a5e48]">
          <strong className="text-[#b09070]">Agent Portraits:</strong> Upload <code className="bg-[#c9a84c]/10 px-1 rounded text-[11px] text-[#e4c76b]">portraits/{"{agentId}"}.png</code> for main portrait, or <code className="bg-[#c9a84c]/10 px-1 rounded text-[11px] text-[#e4c76b]">portraits/{"{agentId}"}/{"{emotion}"}.png</code> for per-emotion sprites (neutral, happy, sad, surprised, serious, blush, angry, thoughtful).<br />
          <strong className="text-[#b09070]">Room Backgrounds:</strong> Upload <code className="bg-[#c9a84c]/10 px-1 rounded text-[11px] text-[#e4c76b]">backgrounds/chamber_{"{agentId}"}.png</code> for chamber backgrounds or <code className="bg-[#c9a84c]/10 px-1 rounded text-[11px] text-[#e4c76b]">backgrounds/{"{scene}"}.png</code> for the West Wing / East Wing / Common shared scenes.<br />
          <strong className="text-[#b09070]">Room Icons:</strong> Upload <code className="bg-[#c9a84c]/10 px-1 rounded text-[11px] text-[#e4c76b]">icons/{"{roomId}"}.png</code> to replace a room's emoji marker on the castle map — falls back to the emoji automatically if no icon is uploaded.<br />
          <strong className="text-[#b09070]">Audio:</strong> Upload <code className="bg-[#c9a84c]/10 px-1 rounded text-[11px] text-[#e4c76b]">bgm/{"{track}"}.ogg</code> or <code className="bg-[#c9a84c]/10 px-1 rounded text-[11px] text-[#e4c76b]">sfx/{"{effect}"}.ogg</code> files.<br />
          <span className="font-mono text-[11px] text-[#8b7355]">Files are stored in: rooms/_shared/vn/assets/</span>
        </p>
      </div>

      <div className="flex gap-2 mb-4 flex-wrap">
        {AGENTS.map((a) => (
          <button key={a} onClick={() => setFilter(filter === a ? null : a)} className={`px-2 py-2 rounded-full text-[13px] font-medium border transition-colors ${filter === a ? "bg-[#c9a84c] text-[#1a1208] border-[#c9a84c]" : "bg-[#2a2218] text-[#d4c09a] border-[#3a2e1e] hover:border-[#c9a84c]/50"}`}>{a}</button>
        ))}
      </div>

      <div className="flex gap-1 mb-4 border-b border-[#3a2e1e]">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-4 py-2 text-[13px] rounded-t ${tab === t.id ? "bg-[#2a2218] text-[#e4c76b] border-x border-t border-[#3a2e1e]" : "text-[#7a5c30] hover:text-[#d4c09a]"}`}>{t.label}</button>
        ))}
      </div>

      {tab === "portraits" && <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>{renderGrid(assets.portraits, "portraits", true)}</div>}
      {tab === "backgrounds" && <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>{renderGrid(assets.backgrounds, "backgrounds")}</div>}
      {tab === "icons" && <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>{renderGrid(assets.icons, "icons")}</div>}
      {tab === "audio" && (
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
          <div className="text-[#6a5e48] text-base mb-1" style={{ gridColumn: "1 / -1" }}>BGM</div>
          {renderGrid(assets.bgm, "bgm")}
          <div className="text-[#6a5e48] text-base mb-1 mt-3" style={{ gridColumn: "1 / -1" }}>SFX</div>
          {renderGrid(assets.sfx, "sfx")}
        </div>
      )}
      {tab === "upload" && (
        <>
        <div className="mb-5">
          <h2 className="text-[15px] text-[#e4c76b] font-semibold mb-2">📐 Asset Size & Format Guide</h2>
          <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
            <div className="bg-[#2a2218] border border-[#3a2e1e] rounded p-3.5">
              <div className="text-[28px] mb-1.5">🖼️</div>
              <div className="text-[13px] text-[#e4c76b] font-semibold mb-1.5">Agent Portrait</div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">Recommended: <strong className="text-[#b09070]">512×768</strong> or <strong className="text-[#b09070]">768×1024</strong> PNG (transparent), GIF, JPG</div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">Min: 256×384. Max: 1024×1536.</div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">Supports <strong className="text-[#b09070]">transparent PNG</strong> and <strong className="text-[#b09070]">animated GIF</strong></div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">File: <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">portraits/{"{agentId}"}.png</code> (main)</div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">Emotions: <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">portraits/{"{agentId}"}/{"{emotion}"}.png</code></div>
              <div className="text-[9px] text-[#5a4e38] mt-1">Emotions: neutral, slight_smile, happy, sad, surprised, serious, blush, angry, thoughtful</div>
            </div>
            <div className="bg-[#2a2218] border border-[#3a2e1e] rounded p-3.5">
              <div className="text-[28px] mb-1.5">🏞️</div>
              <div className="text-[13px] text-[#e4c76b] font-semibold mb-1.5">Room Background</div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">Recommended: <strong className="text-[#b09070]">1920×1080</strong> PNG or WebP</div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">Min: 1280×720. Supports any 16:9 ratio.</div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">File: <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">backgrounds/chamber_{"{agentId}"}.png</code></div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">Shared scenes: <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">castle_common.png</code>, <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">castle_west.png</code>, <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">castle_east.png</code> — pick these via the "Shared Scene" dropdown below</div>
            </div>
            <div className="bg-[#2a2218] border border-[#3a2e1e] rounded p-3.5">
              <div className="text-[28px] mb-1.5">📍</div>
              <div className="text-[13px] text-[#e4c76b] font-semibold mb-1.5">Room Icon</div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">Recommended: <strong className="text-[#b09070]">256×256</strong> PNG (transparent)</div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">Replaces the emoji marker for one room on the castle map.</div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">File: <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">icons/{"{roomId}"}.png</code></div>
              <div className="text-[9px] text-[#5a4e38] mt-1">roomId = agent id for chambers (bruno, eli, …) or hall / library / observatory / forge / bodega / bridge / west-wing / east-wing</div>
            </div>
            <div className="bg-[#2a2218] border border-[#3a2e1e] rounded p-3.5">
              <div className="text-[28px] mb-1.5">🎵</div>
              <div className="text-[13px] text-[#e4c76b] font-semibold mb-1.5">BGM Track</div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">Format: <strong className="text-[#b09070]">OGG</strong> (Vorbis) or <strong className="text-[#b09070]">MP3</strong></div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">Bitrate: 128-192kbps. Loops automatically.</div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">File: <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">warm_theme.ogg</code>, <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">calm_theme.ogg</code>, <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">tense_theme.ogg</code>, <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">mysterious_theme.ogg</code>, <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">bright_theme.ogg</code>, <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">neutral_theme.ogg</code></div>
            </div>
            <div className="bg-[#2a2218] border border-[#3a2e1e] rounded p-3.5">
              <div className="text-[28px] mb-1.5">🔔</div>
              <div className="text-[13px] text-[#e4c76b] font-semibold mb-1.5">Sound Effect</div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">Format: <strong className="text-[#b09070]">OGG</strong> (Vorbis) or <strong className="text-[#b09070]">MP3</strong></div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">Duration: 0.5–3 seconds. Mono or stereo.</div>
              <div className="text-[11px] text-[#8b7355] mb-1 leading-relaxed">File: <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">door_open.ogg</code>, <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">transition_whoosh.ogg</code>, <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">choice_select.ogg</code>, <code className="bg-[#c9a84c]/10 px-1 rounded text-[10px] text-[#c9a84c]">character_enter.ogg</code></div>
            </div>
          </div>
        </div>
        <div
          ref={dropZoneRef}
          onDragOver={(e) => { e.preventDefault(); dropZoneRef.current?.classList.add("dragover"); }}
          onDragLeave={() => dropZoneRef.current?.classList.remove("dragover")}
          onDrop={(e) => {
            e.preventDefault(); dropZoneRef.current?.classList.remove("dragover");
            if (fileInputRef.current && e.dataTransfer.files[0]) {
              const dt = new DataTransfer(); dt.items.add(e.dataTransfer.files[0]);
              fileInputRef.current.files = dt.files;
            }
          }}
          className="max-w-md bg-[#2a2218] border border-[#3a2e1e] rounded-lg p-4"
        >
          <div className="grid gap-2 items-center text-[12px]" style={{ gridTemplateColumns: "auto 1fr" }}>
            <label className="text-[#7a5c30]">Type</label>
            <select value={uploadType} onChange={(e) => setUploadType(e.target.value as AssetType)} className="bg-[#1a1208] border border-[#3a2e1e] rounded px-2 py-1 text-[#d4c09a]">
              <option value="portraits">portraits</option>
              <option value="backgrounds">backgrounds</option>
              <option value="icons">room icons</option>
              <option value="bgm">bgm</option>
              <option value="sfx">sfx</option>
            </select>
            {uploadType === "backgrounds" && (
              <>
                <label className="text-[#7a5c30]">Shared Scene</label>
                <select value={uploadScene} onChange={(e) => setUploadScene(e.target.value)} className="bg-[#1a1208] border border-[#3a2e1e] rounded px-2 py-1 text-[#d4c09a]">
                  <option value="">— use Agent below for a chamber —</option>
                  {SHARED_SCENES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </>
            )}
            {uploadType === "icons" && (
              <>
                <label className="text-[#7a5c30]">Room</label>
                <select value={uploadRoom} onChange={(e) => setUploadRoom(e.target.value)} className="bg-[#1a1208] border border-[#3a2e1e] rounded px-2 py-1 text-[#d4c09a]">
                  <option value="">—</option>
                  {ROOM_ICONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </>
            )}
            {uploadType !== "icons" && (
              <>
                <label className="text-[#7a5c30]">Agent</label>
                <select value={uploadAgent} onChange={(e) => setUploadAgent(e.target.value)} disabled={uploadType === "backgrounds" && !!uploadScene} className="bg-[#1a1208] border border-[#3a2e1e] rounded px-2 py-1 text-[#d4c09a] disabled:opacity-40">
                  <option value="">—</option>
                  {AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </>
            )}
            <label className="text-[#7a5c30]">Emotion</label>
            <input value={uploadEmotion} onChange={(e) => setUploadEmotion(e.target.value)} placeholder="neutral" className="bg-[#1a1208] border border-[#3a2e1e] rounded px-2 py-1 text-[#d4c09a]" />
            <label className="text-[#7a5c30]">File</label>
            <input ref={fileInputRef} type="file" className="text-[#d4c09a] file:bg-[#3a2e1e] file:border-0 file:text-[#e4c76b] file:px-2 file:py-1 file:rounded file:mr-2" />
          </div>
          <button onClick={uploadAsset} className="mt-3 px-3 py-1.5 rounded bg-[#c9a84c] text-[#1a1208] text-[12px] font-semibold hover:bg-[#e4c76b]">Upload</button>
          {uploadStatus && (
            <div className={`mt-2 text-[12px] px-2 py-1 rounded ${uploadStatus.cls === "ok" ? "bg-green-900/40 text-green-300" : uploadStatus.cls === "err" ? "bg-red-900/40 text-red-300" : "bg-blue-900/40 text-blue-300"}`}>{uploadStatus.msg}</div>
          )}
        </div>
        </>
      )}
    </div>
    </div>
  );
}
