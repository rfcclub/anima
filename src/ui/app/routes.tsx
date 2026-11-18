import { Routes, Route, useParams } from "react-router-dom";
import { lazy, Suspense, createElement } from "react";

const TownPage = lazy(() => import("../features/town/pages/TownPage").then((m) => ({ default: m.TownPage })));
const PublicRoomPage = lazy(() => import("../features/town/pages/PublicRoomPage").then((m) => ({ default: m.PublicRoomPage })));
const CostPage = lazy(() => import("../features/cost/pages/CostPage").then((m) => ({ default: m.CostPage })));
const WorkPage = lazy(() => import("../features/work/pages/WorkPage").then((m) => ({ default: m.WorkPage })));
const VnAssetsPage = lazy(() => import("../features/vn-assets/pages/VnAssetsPage").then((m) => ({ default: m.VnAssetsPage })));
const NarrativePage = lazy(() => import("../features/vn-assets/pages/NarrativePage").then((m) => ({ default: m.NarrativePage })));
const LogsPage = lazy(() => import("../features/logs/pages/LogsPage").then((m) => ({ default: m.LogsPage })));
const StatusDashboardPage = lazy(() => import("../features/status/pages/StatusDashboardPage"));
const MainScreen = lazy(() => import("../features/castle/pages/MainScreen").then((m) => ({ default: m.MainScreen })));
const WestWingScreen = lazy(() => import("../features/castle/pages/WestWingScreen").then((m) => ({ default: m.WestWingScreen })));
const EastWingScreen = lazy(() => import("../features/castle/pages/EastWingScreen").then((m) => ({ default: m.EastWingScreen })));
const RoomScreen = lazy(() => import("../features/castle/pages/RoomScreen").then((m) => ({ default: m.RoomScreen })));

function Loading() {
  return createElement("div", { className: "p-4 text-neutral-400" }, "Loading…");
}

/** Wrapper that keys RoomScreen by the :agent param so a client-side
 *  room→room navigation (/rooms/eli → /rooms/bruno) remounts the component,
 *  resetting all request-scoped UI state (addressee, turns, bootedRef).
 *  Without the key, React reuses the instance and the previous room's
 *  background/transcript/addressee survive into the new room (SC-306/307). */
function RoomRoute() {
  const { agent } = useParams<{ agent: string }>();
  return <RoomScreen key={agent} />;
}

export function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/" element={<TownPage />} />
        <Route path="/hall" element={<PublicRoomPage />} />
        <Route path="/library" element={<PublicRoomPage />} />
        <Route path="/observatory" element={<PublicRoomPage />} />
        <Route path="/forge" element={<PublicRoomPage />} />
        <Route path="/bodega" element={<PublicRoomPage />} />
        <Route path="/bridge" element={<PublicRoomPage />} />
        <Route path="/castle" element={<MainScreen />} />
        <Route path="/westwing" element={<WestWingScreen />} />
        <Route path="/eastwing" element={<EastWingScreen />} />
        <Route path="/rooms/:agent" element={<RoomRoute />} />
        <Route path="/cost" element={<CostPage />} />
        <Route path="/work" element={<WorkPage />} />
        <Route path="/vn-assets" element={<VnAssetsPage />} />
        <Route path="/narrative" element={<NarrativePage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/projects" element={<StatusDashboardPage />} />
        <Route path="*" element={<div className="p-4">Not found</div>} />
      </Routes>
    </Suspense>
  );
}
