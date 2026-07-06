import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Overview from './pages/Overview';
import TopicGraph from './pages/TopicGraph';
import Brokers from './pages/Brokers';
import OpcUa from './pages/OpcUa';
import Cesmii from './pages/Cesmii';
import I3x from './pages/I3x';
import Flows from './pages/Flows';
import Discovery from './pages/Discovery';
import Settings from './pages/Settings';

// Internal, unlinked benchmark/verification page for the big-graph renderers.
const Bench = lazy(() => import('./pages/Bench'));

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="topics" element={<TopicGraph />} />
        <Route path="brokers" element={<Brokers />} />
        <Route path="opcua" element={<OpcUa />} />
        <Route path="cesmii" element={<Cesmii />} />
        <Route path="i3x" element={<I3x />} />
        <Route path="flows" element={<Flows />} />
        <Route path="discovery" element={<Discovery />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
      <Route
        path="/bench"
        element={
          <Suspense fallback={<div className="grid h-screen place-items-center text-slate-400">Loading bench…</div>}>
            <Bench />
          </Suspense>
        }
      />
    </Routes>
  );
}
